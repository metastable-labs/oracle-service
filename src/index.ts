import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

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
	// Scheduled task: Check for new markets every 5 minutes
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		console.log('Running scheduled market sync');
		ctx.waitUntil(syncNewMarkets(env));
	},

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

		await addMarketToDO(env, {
			marketId,
			sourceMarketId,
			storkAssetId: sourceMarketId,
			name,
			lastPrice: 0,
			lastUpdate: 0,
		});

		return new Response('Market added successfully', { status: 200 });
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

			await addMarketToDO(env, {
				marketId: marketId as string,
				sourceMarketId: sourceMarketId as string,
				storkAssetId: sourceMarketId as string,
				name: name as string,
				lastPrice: 0,
				lastUpdate: 0,
			});

			console.log(`Added market: ${name}`);
		}
	} catch (error) {
		console.error('Error syncing markets:', error);
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
