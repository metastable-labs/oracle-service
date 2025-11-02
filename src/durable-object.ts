import { DurableObject } from 'cloudflare:workers';
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

interface MarketMapping {
	marketId: string; // bytes32 on-chain ID
	sourceMarketId: string;
	storkAssetId: string; // Stork feed ID
	name: string;
	lastPrice: number;
	lastUpdate: number;
}

interface PendingUpdate {
	marketId: string;
	price: number;
	timestamp: number;
}

const FACTORY_ABI = parseAbi([
	'event MarketCreated(bytes32 indexed marketId, string name, string sourcePlatform, string sourceMarketId, uint64 expiryTimestamp, address indexed creator)',
]);

export class StorkSubscriber extends DurableObject {
	private ws: WebSocket | null = null;
	private markets: Map<string, MarketMapping> = new Map(); // storkAssetId → MarketMapping
	private connectionInitialized = false;
	private pingInterval: ReturnType<typeof setInterval> | null = null;
	private eventWatcherActive = false;
	private unwatchEvents: (() => void) | null = null;

	constructor(ctx: DurableObjectState, env: any) {
		super(ctx, env);

		// Load markets from storage
		this.ctx.blockConcurrencyWhile(async () => {
			const stored = await this.ctx.storage.get<Record<string, MarketMapping>>('markets');
			if (stored) {
				this.markets = new Map(Object.entries(stored));
			}
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Auto-initialize WebSocket connection on first request
		if (!this.connectionInitialized && this.markets.size > 0) {
			this.connectionInitialized = true;
			this.connectToStork(); // Don't await - let it connect in background
		}

		// Initialize WebSocket connection
		if (url.pathname === '/connect') {
			this.connectionInitialized = true;
			await this.connectToStork();
			return new Response('Connected to Stork');
		}

		// Start watching for MarketCreated events
		if (url.pathname === '/watch-events') {
			await this.startEventWatcher();
			return new Response('Event watcher started');
		}

		// Add new market (called when MarketFactory creates a market)
		if (url.pathname === '/add-market' && request.method === 'POST') {
			const market: MarketMapping = await request.json();
			await this.addMarket(market);
			return new Response(`Added market: ${market.name}`);
		}

		// Get all markets
		if (url.pathname === '/markets') {
			return Response.json(Array.from(this.markets.values()));
		}

		// Remove market
		if (url.pathname === '/remove-market' && request.method === 'POST') {
			const { storkAssetId } = (await request.json()) as { storkAssetId: string };
			await this.removeMarket(storkAssetId);
			return new Response(`Removed market`);
		}

		return new Response('Stork Subscriber DO');
	}

	// Alarm handler - processes pending updates and keeps DO alive
	async alarm() {
		try {
			// Keep-alive: Reschedule alarm for 25 seconds from now
			// This prevents the DO from hibernating
			await this.ctx.storage.setAlarm(Date.now() + 25000);

			const pending = await this.ctx.storage.get<PendingUpdate[]>('pending_updates');

			if (!pending || pending.length === 0) {
				return;
			}

			console.log(`Processing ${pending.length} pending updates`);

			// Submit to blockchain
			await this.submitUpdatesToBlockchain(pending);

			// Clear pending updates
			await this.ctx.storage.delete('pending_updates');
		} catch (error) {
			console.error('Error in alarm handler:', error);
			// Reschedule alarm for retry in 30 seconds
			await this.ctx.storage.setAlarm(Date.now() + 30000);
		}
	}

	private async connectToStork() {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			console.log('WebSocket already connected');
			return;
		}

		console.log('Attempting to connect to Stork WebSocket...');

		try {
			const apiKey = (this.env as any).STORK_API_KEY;

			if (!apiKey) {
				throw new Error('STORK_API_KEY not configured');
			}

			const wsUrl = 'https://api.jp.stork-oracle.network/evm/subscribe';
			console.log(`Connecting to ${wsUrl}...`);

			const resp = await fetch(wsUrl, {
				headers: {
					Upgrade: 'websocket',
					Authorization: `Basic ${apiKey}`,
					'Sec-WebSocket-Extensions': 'permessage-deflate',
				},
			});

			console.log(`Fetch response status: ${resp.status}`);

			const ws = resp.webSocket;
			if (!ws) {
				// Read the response body to see the error
				const body = await resp.text();
				console.error('Response has no webSocket property');
				console.error('Response body:', body);
				console.error('Response headers:', JSON.stringify(Object.fromEntries(resp.headers)));
				throw new Error(`Server did not accept WebSocket (${resp.status}): ${body}`);
			}

			ws.accept();
			this.ws = ws;

			console.log('Connected to Stork WebSocket');

			// Start heartbeat to keep connection alive
			this.startHeartbeat();

			this.ws.addEventListener('message', async (event) => {
				try {
					const message = JSON.parse(event.data as string);
					console.log('Received message:', message.type);

					if (message.type === 'oracle_prices') {
						await this.handlePriceUpdate(message);
					}
				} catch (error) {
					console.error('Error processing message:', error);
				}
			});

			this.ws.addEventListener('close', (event) => {
				console.log(`WebSocket closed (code: ${event.code}), reconnecting in 5s...`);
				this.stopHeartbeat();
				this.ws = null;
				setTimeout(() => this.connectToStork(), 5000);
			});

			this.ws.addEventListener('error', (error) => {
				console.error('WebSocket error:', error);
			});

			console.log(`Subscribing to ${this.markets.size} markets...`);

			if (this.markets.size > 0) {
				const assetIds = Array.from(this.markets.keys());
				this.subscribeToAssets(assetIds);
			}
		} catch (error) {
			console.error('Failed to connect to Stork:', error);
			console.error('Error details:', error instanceof Error ? error.message : String(error));
			this.stopHeartbeat();
			setTimeout(() => this.connectToStork(), 5000);
		}
	}

	private async handlePriceUpdate(message: any) {
		// Stork sends data as: { type: 'oracle_prices', data: { ASSET_ID: {...}, ... } }
		const { data } = message;

		if (!data || typeof data !== 'object') {
			console.warn('Invalid message format:', message);
			return;
		}

		// Iterate through all assets in the message
		for (const [assetId, assetData] of Object.entries(data)) {
			const market = this.markets.get(assetId);
			if (!market) {
				console.log(`Received price for unknown market: ${assetId}`);
				continue;
			}

			const { price, timestamp } = assetData as any;

			// Convert Stork price (scaled by 10^18) to probability (0-1)
			// Example: "500000000000000000" (0.5 * 10^18) = 0.5 probability = 50%
			const probability = parseFloat(price) / 1e18;

			// Convert probability to basis points (0-10000)
			// 0.5 probability = 5000 basis points (50%)
			const basisPoints = Math.round(probability * 10000);

			// Validate probability range (0% - 100%)
			if (basisPoints < 0 || basisPoints > 10000) {
				console.warn(`Invalid price ${basisPoints}bp (probability ${probability}) for ${assetId}`);
				continue;
			}

			// Skip if price hasn't changed at all
			if (market.lastPrice === basisPoints) {
				console.log(`Price unchanged for ${market.name}: ${basisPoints}bp`);
				continue;
			}

			const priceDiff = Math.abs(market.lastPrice - basisPoints);
			console.log(`📊 New price for ${market.name}: ${market.lastPrice}bp → ${basisPoints}bp (${probability * 100}%, Δ${priceDiff}bp)`);

			// Update last price in memory
			market.lastPrice = basisPoints;
			market.lastUpdate = timestamp || Date.now();

			// Add to pending updates
			const pending = (await this.ctx.storage.get<PendingUpdate[]>('pending_updates')) || [];
			pending.push({
				marketId: market.marketId,
				price: basisPoints,
				timestamp: market.lastUpdate,
			});

			await this.ctx.storage.put('pending_updates', pending);

			// Schedule alarm to process updates (2 seconds to batch rapid updates)
			// This also serves as keep-alive
			await this.ctx.storage.setAlarm(Date.now() + 2000);
		}
	}

	private async submitUpdatesToBlockchain(updates: PendingUpdate[]) {
		// Call the main worker to submit transaction
		// We use fetch to trigger the worker
		const workerUrl = (this.env as any).WORKER_URL;
		const response = await fetch(`${workerUrl}/submit-batch`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ updates }),
		});

		if (!response.ok) {
			throw new Error(`Failed to submit updates: ${response.status}`);
		}

		console.log(`✅ Submitted ${updates.length} updates to blockchain`);
	}

	private async addMarket(market: MarketMapping) {
		this.markets.set(market.storkAssetId, market);

		// Persist to storage
		await this.ctx.storage.put('markets', Object.fromEntries(this.markets));

		// Subscribe if WebSocket is active
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.subscribeToAssets([market.storkAssetId]);
		}

		console.log(`✅ Added market: ${market.name} (${market.storkAssetId})`);
	}

	private async removeMarket(storkAssetId: string) {
		this.markets.delete(storkAssetId);
		await this.ctx.storage.put('markets', Object.fromEntries(this.markets));

		// Unsubscribe from Stork
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(
				JSON.stringify({
					type: 'unsubscribe',
					trace_id: `unsub-${Date.now()}`,
					data: [storkAssetId],
				})
			);
		}
	}

	private subscribeToAssets(assetIds: string[]) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			console.log('Cannot subscribe: WebSocket not connected');
			return;
		}

		if (assetIds.length === 0) {
			return;
		}

		const message = {
			type: 'subscribe',
			trace_id: `sub-${Date.now()}`,
			data: assetIds,
		};

		this.ws.send(JSON.stringify(message));

		console.log(`📡 Subscribed to ${assetIds.length} asset(s): ${assetIds.join(', ')}`);
	}

	private startHeartbeat() {
		this.stopHeartbeat();

		// Send ping every 30 seconds to keep connection alive
		this.pingInterval = setInterval(() => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				try {
					this.ws.send(JSON.stringify({ type: 'ping' }));
					console.log('Sent heartbeat ping');
				} catch (error) {
					console.error('Failed to send ping:', error);
				}
			}
		}, 30000);
	}

	private stopHeartbeat() {
		if (this.pingInterval) {
			clearInterval(this.pingInterval);
			this.pingInterval = null;
		}
	}

	private async startEventWatcher() {
		if (this.eventWatcherActive) {
			console.log('Event watcher already running');
			return;
		}

		console.log('Starting MarketCreated event watcher...');

		// Set initial alarm to keep DO alive
		const existingAlarm = await this.ctx.storage.getAlarm();
		if (!existingAlarm) {
			await this.ctx.storage.setAlarm(Date.now() + 25000);
			console.log('Keep-alive alarm set');
		}

		const publicClient = createPublicClient({
			chain: base,
			transport: http((this.env as any).BASE_SEPOLIA_RPC_URL),
		});

		const factoryAddress = (this.env as any).MARKET_FACTORY_ADDRESS as `0x${string}`;

		this.unwatchEvents = publicClient.watchContractEvent({
			address: factoryAddress,
			abi: FACTORY_ABI,
			eventName: 'MarketCreated',
			onLogs: async (logs) => {
				for (const log of logs) {
					const { marketId, name, sourcePlatform, sourceMarketId } = log.args;

					console.log(`New market detected: ${name}`);

					try {
						const workerUrl = (this.env as any).WORKER_URL;
						const response = await fetch(`${workerUrl}/add-market`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								marketId,
								name,
								sourcePlatform,
								sourceMarketId,
							}),
						});

						if (response.ok) {
							console.log(`Market added successfully: ${name}`);
						} else {
							console.error(`Failed to add market: ${response.status}`);
						}
					} catch (error) {
						console.error('Error adding market:', error);
					}
				}
			},
			onError: (error) => {
				console.error('Event watcher error:', error);
			},
		});

		this.eventWatcherActive = true;
		console.log('Event watcher started');
	}

	private stopEventWatcher() {
		if (this.unwatchEvents) {
			this.unwatchEvents();
			this.unwatchEvents = null;
			this.eventWatcherActive = false;
			console.log('Event watcher stopped');
		}
	}
}
