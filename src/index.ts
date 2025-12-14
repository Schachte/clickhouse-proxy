#!/usr/bin/env node

import { exec } from "child_process";
import * as fs from "fs";
import * as yaml from "js-yaml";
import * as http from "http";
import * as https from "https";
import { promisify } from "util";

interface ProxyConfig {
  listenPort: number;
  targetHost: string;
  targetPort: number;
  targetScheme: string;
  cloudflaredAppUrl: string;
  tokenCacheDurationMs: number;
  cookieName: string;
  clickhouseUsername: string;
  clickhousePassword: string;
}

const execPromise = promisify(exec);
let cachedToken: string | null = null;
let tokenExpiry = 0;

function loadConfig(): ProxyConfig {
  try {
    const configPath =
      process.env.CONFIG_PATH ||
      "./conf/config.yml";
    console.log(
      `[${new Date().toISOString()}] Loading configuration from: ${configPath}`,
    );

    const fileContents = fs.readFileSync(configPath, "utf8");
    const config = yaml.load(fileContents) as { proxy: ProxyConfig };

    if (!config.proxy) {
      throw new Error("Proxy configuration is missing in the config file.");
    }

    const required = [
      "listenPort",
      "targetHost",
      "targetPort",
      "cloudflaredAppUrl",
      "clickhouseUsername",
      "clickhousePassword",
    ];
    for (const field of required) {
      if (!(field in config.proxy)) {
        throw new Error(
          `Required field '${field}' is missing from proxy configuration.`,
        );
      }
    }

    return config.proxy;
  } catch (error) {
    console.error(
      `Error loading config: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

async function fetchToken(appUrl: string): Promise<string> {
  const command = `cloudflared access token --app=${appUrl}`;
  console.log(`[${new Date().toISOString()}] Fetching new token...`);
  try {
    const { stdout, stderr } = await execPromise(command);
    if (stderr) {
      console.error(
        `[${new Date().toISOString()}] Error fetching token (stderr):`,
        stderr,
      );
      throw new Error(`cloudflared stderr: ${stderr}`);
    }
    const token = stdout.trim();
    if (!token) {
      throw new Error("cloudflared command returned empty token");
    }
    console.log(
      `[${new Date().toISOString()}] Successfully fetched new token.`,
    );
    return token;
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to execute cloudflared command:`,
      error,
    );
    throw error;
  }
}

async function getToken(proxyConfig: ProxyConfig): Promise<string | null> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  console.log(
    `[${new Date().toISOString()}] Cache expired or token needed. Attempting fetch.`,
  );
  try {
    const newToken = await fetchToken(proxyConfig.cloudflaredAppUrl);
    cachedToken = newToken;
    tokenExpiry = now + proxyConfig.tokenCacheDurationMs;
    return cachedToken;
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Could not get token. Proxy request might fail.`,
    );
    tokenExpiry = 0;
    cachedToken = null;
    return null;
  }
}

function startProxyServer(proxyConfig: ProxyConfig): void {
  const server = http.createServer(async (clientReq, clientRes) => {
    console.log(
      `[${new Date().toISOString()}] Received request: ${clientReq.method} ${clientReq.url}`,
    );

    const cfToken = await getToken(proxyConfig);

    if (!cfToken) {
      console.error(
        `[${new Date().toISOString()}] No CF token available. Aborting request.`,
      );
      clientRes.writeHead(500, { "Content-Type": "text/plain" });
      clientRes.end(
        "Internal Server Error: Could not obtain authorization token.",
      );
      return;
    }

    const headers: http.OutgoingHttpHeaders = {};

    if (clientReq.headers) {
      Object.keys(clientReq.headers).forEach((key) => {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey !== "proxy-connection" &&
          lowerKey !== "transfer-encoding" &&
          lowerKey !== "host" &&
          lowerKey !== "authorization"
        ) {
          headers[key] = clientReq.headers[key];
        }
      });
    }

    headers["Host"] = proxyConfig.targetHost;
    headers["Cookie"] = `${proxyConfig.cookieName}=${cfToken}`;
    headers["X-ClickHouse-User"] = proxyConfig.clickhouseUsername;
    headers["X-ClickHouse-Key"] = proxyConfig.clickhousePassword;

    const options = {
      hostname: proxyConfig.targetHost,
      port: proxyConfig.targetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers: headers,
      rejectUnauthorized: true,
    };

    console.log(
      `[${new Date().toISOString()}] Proxying to: ${proxyConfig.targetScheme}://${proxyConfig.targetHost}:${proxyConfig.targetPort}${options.path}`,
    );

    const proxyReq = https.request(options, (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(clientRes, { end: true });
    });

    proxyReq.on("error", (err) => {
      console.error(
        `[${new Date().toISOString()}] Error proxying request to ${proxyConfig.targetHost}:`,
        err,
      );
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "text/plain" });
      }
      clientRes.end(`Bad Gateway: ${err.message}`);
    });

    clientReq.pipe(proxyReq, { end: true });
  });

  server.listen(proxyConfig.listenPort, "0.0.0.0", () => {
    console.log(
      `[${new Date().toISOString()}] Proxy server listening on http://127.0.0.1:${proxyConfig.listenPort}`,
    );
    console.log(
      `[${new Date().toISOString()}] Forwarding requests to ${proxyConfig.targetScheme}://${proxyConfig.targetHost}:${proxyConfig.targetPort}`,
    );
    console.log(
      `[${new Date().toISOString()}] Injecting CF Access cookie and ClickHouse auth for user: ${proxyConfig.clickhouseUsername}`,
    );
  });

  server.on("error", (err) => {
    console.error(`[${new Date().toISOString()}] Server error:`, err);
  });
}

async function main(): Promise<void> {
  console.log(`[${new Date().toISOString()}] ClickHouse Proxy starting...`);

  const proxyConfig = loadConfig();

  console.log(
    `[${new Date().toISOString()}] Configuration loaded successfully`,
  );
  console.log(
    `[${new Date().toISOString()}] Target: ${proxyConfig.targetScheme}://${proxyConfig.targetHost}:${proxyConfig.targetPort}`,
  );
  console.log(
    `[${new Date().toISOString()}] ClickHouse User: ${proxyConfig.clickhouseUsername}`,
  );

  console.log(
    `[${new Date().toISOString()}] Attempting initial token fetch...`,
  );
  try {
    const initialToken = await getToken(proxyConfig);
    if (initialToken) {
      console.log(
        `[${new Date().toISOString()}] Initial Cloudflare Access token obtained successfully.`,
      );
    } else {
      console.warn(
        `[${new Date().toISOString()}] Could not obtain initial token. Will retry on first request.`,
      );
    }

    startProxyServer(proxyConfig);
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Fatal error during startup:`,
      err,
    );
    process.exit(1);
  }
}

const cleanup = (signal: string) => {
  console.log(
    `\n[${new Date().toISOString()}] Received ${signal}. Shutting down proxy server...`,
  );
  console.log(`[${new Date().toISOString()}] Goodbye!`);
  process.exit(0);
};

process.on("SIGINT", () => cleanup("SIGINT"));
process.on("SIGTERM", () => cleanup("SIGTERM"));
process.on("exit", (code) => {
  console.log(
    `[${new Date().toISOString()}] Process exited with code: ${code}`,
  );
});

main().catch((err) => {
  console.error("Fatal error in main:", err);
  process.exit(1);
});
