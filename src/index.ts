#!/usr/bin/env node

import { spawn, ChildProcess, exec } from 'child_process';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as http from 'http';
import * as https from 'https';
import { promisify } from 'util';

interface TunnelConfig {
    name: string;
    command: string;
    args: string[];
}

interface ProxyConfig {
    listenPort: number;
    targetHost: string;
    targetPort: number;
    targetScheme: string;
    cloudflaredAppUrl: string;
    tokenCacheDurationMs: number;
    cookieName: string;
}

const activeProcesses: Map<string, ChildProcess> = new Map();
const execPromise = promisify(exec);
let cachedToken: string | null = null;
let tokenExpiry = 0;

function loadConfig(): { tunnels: TunnelConfig[], proxy: ProxyConfig } {
    try {
        const configPath = process.env.CONFIG_PATH || '/Users/schachte/Documents/Playgrounds/ch_proxy/conf/config.yml';
        console.log(`[${new Date().toISOString()}] Loading configuration from: ${configPath}`);
        
        const fileContents = fs.readFileSync(configPath, 'utf8');
        const config = yaml.load(fileContents) as { 
            tunnels: TunnelConfig[],
            proxy: ProxyConfig
        };
        
        if (!config.proxy) {
            throw new Error('Proxy configuration is missing in the config file.');
        }
        
        return config;
    } catch (error) {
        console.error(`Error loading config: ${error instanceof Error ? error.message : String(error)}`);
        throw new Error('Error loading config');
    }
}

function startTunnel(config: TunnelConfig): void {
    console.log(`[${config.name}] Attempting to start tunnel...`);
    try {
        const proc = spawn(config.command, config.args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        activeProcesses.set(config.name, proc);

        proc.stdout?.on('data', (data: Buffer) => {
            process.stdout.write(`[${config.name} stdout]: ${data.toString()}`);
        });

        proc.stderr?.on('data', (data: Buffer) => {
            process.stderr.write(`[${config.name} stderr]: ${data.toString()}`);
        });

        proc.on('error', (err) => {
            console.error(`[${config.name}] Failed to start process: ${err.message}`);
            activeProcesses.delete(config.name);
        });

        proc.on('close', (code, signal) => {
            console.log(`[${config.name}] Process exited (code: ${code}, signal: ${signal})`);
            activeProcesses.delete(config.name);
        });

        console.log(`[${config.name}] Tunnel process spawned (PID: ${proc.pid})`);

    } catch (error) {
        console.error(`[${config.name}] Error spawning process: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            console.error(`[${config.name}] Is '${config.command}' installed and in your PATH?`);
        }
    }
}

function startAllTunnels(tunnelConfigs: TunnelConfig[]): void {
    console.log('Starting Cloudflare tunnels...');
    if (tunnelConfigs.length === 0) {
        console.log('No tunnels configured.');
        return;
    }
    tunnelConfigs.forEach(startTunnel);
}

function stopAllTunnels(): void {
    console.log('\nShutting down Cloudflare tunnels...');
    if (activeProcesses.size === 0) {
        console.log('No active tunnels to stop.');
        return;
    }
    activeProcesses.forEach((proc, name) => {
        console.log(`[${name}] Sending SIGTERM to process (PID: ${proc.pid})...`);
        const killed = proc.kill('SIGTERM');
        if (!killed) {
            console.warn(`[${name}] Failed to send SIGTERM (PID: ${proc.pid}). Process might already be stopped or unresponsive.`);
        }
    });
}

async function fetchToken(appUrl: string): Promise<string> {
    const command = `cloudflared access token --app=${appUrl}`;
    console.log(`[${new Date().toISOString()}] Fetching new token...`);
    try {
        const { stdout, stderr } = await execPromise(command);
        if (stderr) {
            console.error(`[${new Date().toISOString()}] Error fetching token (stderr):`, stderr);
            throw new Error(`cloudflared stderr: ${stderr}`);
        }
        const token = stdout.trim();
        if (!token) {
             throw new Error('cloudflared command returned empty token');
        }
        console.log(`[${new Date().toISOString()}] Successfully fetched new token.`);
        return token;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to execute cloudflared command:`, error);
        throw error;
    }
}

async function getToken(proxyConfig: ProxyConfig): Promise<string | null> {
    const now = Date.now();
    if (cachedToken && now < tokenExpiry) {
        return cachedToken;
    }

    console.log(`[${new Date().toISOString()}] Cache expired or token needed. Attempting fetch.`);
    try {
        const newToken = await fetchToken(proxyConfig.cloudflaredAppUrl);
        cachedToken = newToken;
        tokenExpiry = now + proxyConfig.tokenCacheDurationMs;
        return cachedToken;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Could not get token. Proxy request might fail.`);
        tokenExpiry = 0;
        cachedToken = null;
        return null;
    }
}

function startProxyServer(proxyConfig: ProxyConfig): void {
    const server = http.createServer(async (clientReq, clientRes) => {
        console.log(`[${new Date().toISOString()}] Received request: ${clientReq.method} ${clientReq.url}`);

        const cfToken = await getToken(proxyConfig);

        if (!cfToken) {
            console.error(`[${new Date().toISOString()}] No CF token available. Aborting request.`);
            clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
            clientRes.end('Internal Server Error: Could not obtain authorization token.');
            return;
        }

        const headers: http.OutgoingHttpHeaders = {};
        
        if (clientReq.headers) {
            Object.keys(clientReq.headers).forEach(key => {
                if (key.toLowerCase() !== 'proxy-connection' && 
                    key.toLowerCase() !== 'transfer-encoding') {
                    headers[key] = clientReq.headers[key];
                }
            });
        }
        
        headers['Host'] = proxyConfig.targetHost;
        headers['Cookie'] = `${proxyConfig.cookieName}=${cfToken}`;
        
        const options = {
            hostname: proxyConfig.targetHost,
            port: proxyConfig.targetPort,
            path: clientReq.url,
            method: clientReq.method,
            headers: headers,
            rejectUnauthorized: true,
        };

        console.log(`[${new Date().toISOString()}] Proxying to: ${proxyConfig.targetScheme}://${proxyConfig.targetHost}:${proxyConfig.targetPort}${options.path}`);

        const proxyReq = https.request(options, (proxyRes) => {
            clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(clientRes, { end: true });
        });

        proxyReq.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] Error proxying request to ${proxyConfig.targetHost}:`, err);
            if (!clientRes.headersSent) {
                clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
            }
            clientRes.end(`Bad Gateway: ${err.message}`);
        });

        clientReq.pipe(proxyReq, { end: true });
    });

    server.listen(proxyConfig.listenPort, '0.0.0.0', () => {
        console.log(`[${new Date().toISOString()}] Proxy server listening on http://127.0.0.1:${proxyConfig.listenPort}`);
        console.log(`[${new Date().toISOString()}] Forwarding requests to ${proxyConfig.targetScheme}://${proxyConfig.targetHost}:${proxyConfig.targetPort}`);
        console.log(`[${new Date().toISOString()}] Injecting cookie: ${proxyConfig.cookieName}`);
    });

    server.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] Server error:`, err);
    });
}

async function main(): Promise<void> {
    const config = loadConfig();
    
    startAllTunnels(config.tunnels);
    
    console.log(`[${new Date().toISOString()}] Attempting initial token fetch...`);
    try {
        const initialToken = await getToken(config.proxy);
        if (initialToken) {
            console.log(`[${new Date().toISOString()}] Initial token obtained successfully.`);
        } else {
            console.warn(`[${new Date().toISOString()}] Could not obtain initial token. Will retry on first request.`);
        }
        
        startProxyServer(config.proxy);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Fatal error during initial token fetch. Proxy cannot start securely.`, err);
        process.exit(1);
    }
}

const cleanup = (signal: string) => {
    console.log(`\nReceived ${signal}. Initiating shutdown...`);
    stopAllTunnels();
    setTimeout(() => {
        console.log('Exiting Node process.');
        process.exit(0);
    }, 1500);
};

process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('exit', (code) => {
    console.log(`Node process exited with code: ${code}`);
});

main().catch(err => {
    console.error('Fatal error in main:', err);
    process.exit(1);
});