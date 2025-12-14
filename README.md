# ClickHouse Proxy

A simple HTTP proxy for accessing ClickHouse databases behind Cloudflare Access. This proxy handles both Cloudflare Access authentication (via CF_Authorization token) and ClickHouse user authentication, making it easy to connect using standard ClickHouse clients.

## Features

- Automatic Cloudflare Access token fetching and caching
- ClickHouse username/password authentication
- Simple local HTTP proxy (no tunnel management required)
- Token refresh handling (5-minute cache by default)
- Works with ClickHouse CLI, JDBC drivers, and other HTTP-based clients

## Prerequisites

- Node.js 18 or higher (or Docker)
- `cloudflared` CLI tool installed and authenticated

  ```bash
  # Install cloudflared (macOS)
  brew install cloudflared

  # Authenticate with Cloudflare Access
  cloudflared access login https://your-clickhouse-host.example.com
  ```

## Installation

1. Clone this repository:

   ```bash
   git clone <repository-url>
   cd clickhouse-proxy
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy the example config and customize it:

   ```bash
   cp conf/config.example.yml conf/config.yml
   ```

4. Edit `conf/config.yml` with your settings:
   ```yaml
   proxy:
     listenPort: 9090
     targetHost: your-clickhouse-host.example.com
     targetPort: 443
     targetScheme: https
     cloudflaredAppUrl: https://your-clickhouse-host.example.com
     tokenCacheDurationMs: 300000
     cookieName: CF_Authorization
     clickhouseUsername: your-username
     clickhousePassword: your-password
   ```

## Usage

### Running the Proxy

**Development mode:**

```bash
npm run dev
```

**Production mode:**

```bash
npm start
```

**Build standalone binary:**

```bash
npm run build
# Binary will be in build/clickhouse-proxy
./build/clickhouse-proxy
```

### Docker

**Build the image:**

```bash
docker build -t clickhouse-proxy .
```

**Build for multiple platforms:**

```bash
# Build for linux/amd64 and linux/arm64
docker buildx build --platform linux/amd64,linux/arm64 -t clickhouse-proxy .
```

**Run with Docker:**

```bash
docker run -d \
  --name clickhouse-proxy \
  -p 9090:9090 \
  -v $(pwd)/conf/config.yml:/app/conf/config.yml:ro \
  clickhouse-proxy
```

**Run with environment-based cloudflared auth:**

```bash
# Mount your cloudflared credentials for token fetching
docker run -d \
  --name clickhouse-proxy \
  -p 9090:9090 \
  -v $(pwd)/conf/config.yml:/app/conf/config.yml:ro \
  -v ~/.cloudflared:/root/.cloudflared:ro \
  clickhouse-proxy
```

### Connecting to ClickHouse

Once the proxy is running on port 9090 (default), you can connect using:

**ClickHouse CLI:**

```bash
clickhouse-client --host 127.0.0.1 --port 9090
```

**HTTP Interface:**

```bash
curl http://localhost:9090/?query=SELECT+1
```

**JDBC Connection String:**

```
jdbc:clickhouse://localhost:9090
```

**Python (clickhouse-driver):**

```python
from clickhouse_driver import Client

client = Client(host='localhost', port=9090)
result = client.execute('SELECT 1')
```

## How It Works

1. The proxy starts a local HTTP server on the configured port (default: 9090)
2. When a request comes in:
   - Fetches a Cloudflare Access token using `cloudflared access token` (or uses cached token)
   - Forwards the request to the remote ClickHouse server
   - Adds three authentication headers:
     - `Cookie: CF_Authorization=<token>` - For Cloudflare Access
     - `X-ClickHouse-User: <username>` - For ClickHouse authentication
     - `X-ClickHouse-Key: <password>` - For ClickHouse authentication
3. Returns the response from ClickHouse to the client

## Configuration Reference

| Field                  | Description                          | Example                                    |
| ---------------------- | ------------------------------------ | ------------------------------------------ |
| `listenPort`           | Local port for the proxy server      | `9090`                                     |
| `targetHost`           | Remote ClickHouse hostname           | `your-clickhouse-host.example.com`         |
| `targetPort`           | Remote ClickHouse port               | `443`                                      |
| `targetScheme`         | Protocol (http or https)             | `https`                                    |
| `cloudflaredAppUrl`    | Cloudflare Access application URL    | `https://your-clickhouse-host.example.com` |
| `tokenCacheDurationMs` | Token cache duration in milliseconds | `300000` (5 minutes)                       |
| `cookieName`           | Cookie name for CF Access token      | `CF_Authorization`                         |
| `clickhouseUsername`   | Your ClickHouse username             | `your-username`                            |
| `clickhousePassword`   | Your ClickHouse password             | `your-password`                            |

## Troubleshooting

**Token fetch fails:**

- Ensure `cloudflared` is installed and in your PATH
- Run `cloudflared access login https://your-clickhouse-host` to authenticate
- Check that the `cloudflaredAppUrl` in config matches your Access application

**Connection refused:**

- Verify the proxy is running on the expected port
- Check that `targetHost` and `targetPort` are correct
- Ensure your ClickHouse credentials are valid

**Authentication errors:**

- Verify your ClickHouse username and password
- Check that you have permission to access the ClickHouse instance

## Development

**Watch mode:**

```bash
npm run dev
```

**Build TypeScript:**

```bash
npm run build
```

**Package as binary:**

```bash
npm run build  # Creates build/clickhouse-proxy
```

## License

MIT
