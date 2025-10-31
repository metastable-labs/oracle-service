import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

interface Env {
	ORACLE_ADDRESS: string;
	MARKET_FACTORY_ADDRESS: string;
	CHAIN_RPC_URL: string;
	PRIVATE_KEY: string;
	STORK_API_KEY: string;
	WORKER_URL: string;

	STORK_SUBSCRIBER: DurableObjectNamespace;
}

const FACTORY_ABI = parseAbi([
	'event MarketCreated(bytes32 indexed marketId, string name, string sourcePlatform, string sourceMarketId, uint64 expiryTimestamp, address indexed creator)',
]);
