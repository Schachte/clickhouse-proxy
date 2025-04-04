# Clickhouse Proxy

Simple Clickhouse proxy that takes advantage of their [HTTP interface](https://clickhouse.com/docs/interfaces/http). 

I needed to access Clickhouse behind Cloudflare Access and wanted a simple proxy that would relay the token and handle automatic refreshing for me. This makes it simple to connect to Clickhouse using external clients using something like `http://localhost:9090`.


## Setup

1. Install dependencies
```bash
npm i
```

2. Replace `conf/conf.example.yml` with `conf/conf.yml
Example:
```
tunnels:
  - name: postgres-tunnel
    command: cloudflared
    args:
      - access
      - tcp
      - --hostname
      - productiondb.databases.cfdata.org/flerkendb/pdx/replica
      - --url
      - 127.0.0.1:5432

proxy:
  listenPort: 9090
  targetHost: clickhouse-ready-analytics.bi.cfdata.org
  targetPort: 443
  targetScheme: https
  cloudflaredAppUrl: https://clickhouse-ready-analytics.bi.cfdata.org
  tokenCacheDurationMs: 300000  # 5 minutes
  cookieName: CF_Authorization
  ```

3. Run using `npm run dev` or build using `npm run build` and place the output script on your `$PATH`.

