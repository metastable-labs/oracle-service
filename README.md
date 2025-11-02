# Price Oracle Feed

Real-time price oracle updater for prediction markets. Fetches probability prices from Stork and updates on-chain oracle contracts.

## How It Works

1. **Market Detection** - Monitors blockchain for new market creation events
2. **Initial Price** - Fetches current price from Stork REST API and submits to oracle
3. **Real-time Updates** - Subscribes to Stork WebSocket for live price feeds
4. **On-chain Updates** - Automatically submits price changes to oracle contract

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.dev.vars`:
```
STORK_API_KEY=your_api_key
PRIVATE_KEY=0x...
BASE_SEPOLIA_RPC_URL=https://...
```

3. Update `wrangler.toml` with your contract addresses:
```toml
ORACLE_ADDRESS = "0x..."
MARKET_FACTORY_ADDRESS = "0x..."
WORKER_URL = "https://your-worker.workers.dev"
```

4. Add market mappings in `src/market-mappings.ts`:
```typescript
export const MARKET_TO_STORK_ASSET: Record<string, string> = {
  'your-source-market-id': 'STORK_ASSET_ID',
};
```

## Deploy

```bash
npx wrangler deploy
```

## Initialize

Trigger the initial connection and market sync:
```bash
curl https://your-worker.workers.dev/init
```

## Endpoints

- `GET /init` - Initialize WebSocket connection and sync markets
- `GET /markets` - List all tracked markets
- `POST /add-market` - Manually add a market
- `POST /submit-batch` - Submit price updates (called by Durable Object)
- `GET /health` - Health check

## Architecture

- **Cloudflare Workers** - Main worker handles HTTP requests and blockchain interactions
- **Durable Objects** - Maintains persistent WebSocket connection to Stork
- **Scheduled Tasks** - Automatically syncs new markets every 5 minutes

## License

MIT

