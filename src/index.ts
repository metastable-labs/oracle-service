import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getStorkAssetId } from './market-mappings';

export { StorkSubscriber } from './durable-object';

// Environment configuration
interface Env {
	ORACLE_ADDRESS: string;
	MARKET_FACTORY_ADDRESS: string;
	BASE_SEPOLIA_RPC_URL: string;
	PRIVATE_KEY: string;
	STORK_API_KEY: string;
	WORKER_URL: string;

	STORK_SUBSCRIBER: DurableObjectNamespace;
}

// Market Factory ABI
const FACTORY_ABI = parseAbi([
	'event MarketCreated(bytes32 indexed marketId, string name, string sourcePlatform, string sourceMarketId, uint64 expiryTimestamp, address indexed creator)',
]);

// Oracle ABI
const ORACLE_ABI = parseAbi(['function updatePrice(bytes32 marketId, uint96 price) external']);

// Types
interface PendingUpdate {
	marketId: string;
	price: number;
	timestamp: number;
}

interface MarketMapping {
	marketId: string;
	sourceMarketId: string;
	storkAssetId: string;
	name: string;
	lastPrice: number;
	lastUpdate: number;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/init') {
			return await handleInit(env);
		}

		if (url.pathname === '/submit-batch' && request.method === 'POST') {
			return await handleBatchSubmit(request, env);
		}

		if (url.pathname === '/add-market' && request.method === 'POST') {
			return await handleAddMarket(request, env);
		}

		if (url.pathname === '/markets') {
			return await handleGetMarkets(env);
		}

		if (url.pathname === '/health') {
			return Response.json({ status: 'ok', timestamp: Date.now() });
		}

		return new Response('Oracle Feed Worker', { status: 200 });
	},
};

async function handleInit(env: Env): Promise<Response> {
	try {
		console.log('Initializing Stork Subscriber...');

		const id = env.STORK_SUBSCRIBER.idFromName('main');
		const stub = env.STORK_SUBSCRIBER.get(id);

		await stub.fetch('http://do/connect');
		console.log('Connected to Stork');

		await stub.fetch('http://do/watch-events');
		console.log('Event watcher started');

		await syncNewMarkets(env);
		console.log('Markets synced');

		return new Response('Initialized successfully', { status: 200 });
	} catch (error) {
		console.error('Initialization failed:', error);
		return new Response(`Initialization failed: ${error}`, { status: 500 });
	}
}

async function handleBatchSubmit(request: Request, env: Env): Promise<Response> {
	try {
		const { updates } = (await request.json()) as { updates: PendingUpdate[] };

		if (!updates || updates.length === 0) {
			return new Response('No updates provided', { status: 400 });
		}

		await submitUpdates(env, updates);
		return new Response('Updates submitted successfully', { status: 200 });
	} catch (error) {
		console.error('Submit failed:', error);
		return new Response(`Submit failed: ${error}`, { status: 500 });
	}
}

async function handleAddMarket(request: Request, env: Env): Promise<Response> {
	try {
		const { marketId, sourcePlatform, sourceMarketId, name } = (await request.json()) as {
			marketId: string;
			sourcePlatform: string;
			sourceMarketId: string;
			name: string;
		};

		if (!marketId || !sourcePlatform || !sourceMarketId || !name) {
			return new Response('Missing required fields', { status: 400 });
		}

		console.log(`Adding market: ${name}`);

		const storkAssetId = getStorkAssetId(sourceMarketId);

		if (!storkAssetId) {
			return new Response(`No Stork asset ID mapping found for sourceMarketId: ${sourceMarketId}. Please add to market-mappings.ts`, {
				status: 400,
			});
		}

		let initialPrice = 5000;

		try {
			const currentPrice = await fetchLatestPriceFromStork(env, storkAssetId);

			if (currentPrice !== null) {
				initialPrice = currentPrice;
				console.log(`Fetched initial price for ${name}: ${initialPrice}bp`);

				await submitInitialPrice(env, marketId, initialPrice);
			}
		} catch (error) {
			console.error(`Failed to fetch/submit initial price for ${name}:`, error);
		}

		await addMarketToDO(env, {
			marketId,
			sourceMarketId,
			storkAssetId,
			name,
			lastPrice: initialPrice,
			lastUpdate: Date.now(),
		});

		return new Response(`Market added with initial price ${initialPrice}bp`, { status: 200 });
	} catch (error) {
		console.error('Add market failed:', error);
		return new Response(`Add market failed: ${error}`, { status: 500 });
	}
}

async function handleGetMarkets(env: Env): Promise<Response> {
	try {
		const id = env.STORK_SUBSCRIBER.idFromName('main');
		const stub = env.STORK_SUBSCRIBER.get(id);
		const response = await stub.fetch('http://do/markets');
		return response;
	} catch (error) {
		console.error('Get markets failed:', error);
		return new Response(`Get markets failed: ${error}`, { status: 500 });
	}
}

async function syncNewMarkets(env: Env) {
	console.log('Syncing markets from blockchain...');

	const publicClient = createPublicClient({
		chain: base,
		transport: http(env.BASE_SEPOLIA_RPC_URL),
	});

	try {
		const id = env.STORK_SUBSCRIBER.idFromName('main');
		const stub = env.STORK_SUBSCRIBER.get(id);
		const response = await stub.fetch('http://do/markets');
		const doMarkets = (await response.json()) as MarketMapping[];
		const trackedMarketIds = new Set(doMarkets.map((m) => m.marketId));

		const currentBlock = await publicClient.getBlockNumber();
		const fromBlock = currentBlock > 1000n ? currentBlock - 1000n : 0n;

		console.log(`Scanning blocks ${fromBlock} to ${currentBlock}...`);

		const logs = await publicClient.getLogs({
			address: env.MARKET_FACTORY_ADDRESS as `0x${string}`,
			event: FACTORY_ABI[0],
			fromBlock,
			toBlock: 'latest',
		});

		console.log(`Found ${logs.length} market creation events`);

		for (const log of logs) {
			const { marketId, name, sourcePlatform, sourceMarketId } = log.args;

			if (trackedMarketIds.has(marketId as string)) {
				console.log(`Skipping already tracked market: ${name}`);
				continue;
			}

			console.log(`New market detected: ${name}`);

			const storkAssetId = getStorkAssetId(sourceMarketId as string);

			if (!storkAssetId) {
				console.error(`No Stork asset ID mapping found for sourceMarketId: ${sourceMarketId}`);
				console.error(`Please add mapping to market-mappings.ts`);
				continue;
			}

			let initialPrice = 5000;

			try {
				const currentPrice = await fetchLatestPriceFromStork(env, storkAssetId);

				if (currentPrice !== null) {
					initialPrice = currentPrice;
					console.log(`Fetched initial price for ${name}: ${initialPrice}bp`);

					await submitInitialPrice(env, marketId as string, initialPrice);
				}
			} catch (error) {
				console.error(`Failed to fetch/submit initial price for ${name}:`, error);
			}

			await addMarketToDO(env, {
				marketId: marketId as string,
				sourceMarketId: sourceMarketId as string,
				storkAssetId,
				name: name as string,
				lastPrice: initialPrice,
				lastUpdate: Date.now(),
			});

			console.log(`Added market: ${name} with initial price ${initialPrice}bp`);
		}
	} catch (error) {
		console.error('Error syncing markets:', error);
		throw error;
	}
}

async function fetchLatestPriceFromStork(env: Env, assetId: string): Promise<number | null> {
	try {
		const response = await fetch(`https://rest.jp.stork-oracle.network/v1/prices/latest?assets=${assetId}`, {
			headers: {
				Authorization: `Basic ${env.STORK_API_KEY}`,
			},
		});

		if (!response.ok) {
			console.error(`Stork API error: ${response.status}`);
			return null;
		}

		const data = (await response.json()) as Record<string, any>;
		const assetData = data[assetId];

		if (!assetData || !assetData.price) {
			console.error(`No price data for ${assetId}`);
			return null;
		}

		const probability = parseFloat(assetData.price) / 1e18;
		const basisPoints = Math.round(probability * 10000);

		if (basisPoints < 0 || basisPoints > 10000) {
			console.error(`Invalid price ${basisPoints}bp for ${assetId}`);
			return null;
		}

		return basisPoints;
	} catch (error) {
		console.error(`Error fetching price from Stork:`, error);
		return null;
	}
}

async function submitInitialPrice(env: Env, marketId: string, price: number) {
	const account = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);

	const publicClient = createPublicClient({
		chain: base,
		transport: http(env.BASE_SEPOLIA_RPC_URL),
	});

	const walletClient = createWalletClient({
		account,
		chain: base,
		transport: http(env.BASE_SEPOLIA_RPC_URL),
	});

	try {
		await publicClient.simulateContract({
			address: env.ORACLE_ADDRESS as `0x${string}`,
			abi: ORACLE_ABI,
			functionName: 'updatePrice',
			args: [marketId as `0x${string}`, BigInt(price)],
			account,
		});

		const hash = await walletClient.writeContract({
			address: env.ORACLE_ADDRESS as `0x${string}`,
			abi: ORACLE_ABI,
			functionName: 'updatePrice',
			args: [marketId as `0x${string}`, BigInt(price)],
		});

		console.log(`Initial price submitted: ${hash}`);

		const receipt = await publicClient.waitForTransactionReceipt({
			hash,
			timeout: 60_000,
		});

		console.log(`Initial price confirmed in block ${receipt.blockNumber}`);
	} catch (error) {
		console.error(`Error submitting initial price:`, error);
		throw error;
	}
}

async function addMarketToDO(env: Env, market: MarketMapping) {
	const id = env.STORK_SUBSCRIBER.idFromName('main');
	const stub = env.STORK_SUBSCRIBER.get(id);

	await stub.fetch('http://do/add-market', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(market),
	});
}

async function submitUpdates(env: Env, updates: PendingUpdate[]) {
	console.log(`Submitting ${updates.length} price updates`);

	const account = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);

	const publicClient = createPublicClient({
		chain: base,
		transport: http(env.BASE_SEPOLIA_RPC_URL),
	});

	const walletClient = createWalletClient({
		account,
		chain: base,
		transport: http(env.BASE_SEPOLIA_RPC_URL),
	});

	for (const update of updates) {
		try {
			await publicClient.simulateContract({
				address: env.ORACLE_ADDRESS as `0x${string}`,
				abi: ORACLE_ABI,
				functionName: 'updatePrice',
				args: [update.marketId as `0x${string}`, BigInt(update.price)],
				account,
			});

			const hash = await walletClient.writeContract({
				address: env.ORACLE_ADDRESS as `0x${string}`,
				abi: ORACLE_ABI,
				functionName: 'updatePrice',
				args: [update.marketId as `0x${string}`, BigInt(update.price)],
			});

			console.log(`Transaction submitted: ${hash}`);

			const receipt = await publicClient.waitForTransactionReceipt({
				hash,
				timeout: 60_000,
			});

			console.log(`Price update confirmed in block ${receipt.blockNumber}`);
		} catch (error) {
			console.error(`Error submitting update for ${update.marketId}:`, error);
		}
	}
}
