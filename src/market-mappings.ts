/**
 * Manual mapping from source market IDs to Stork asset IDs
 *
 * Until Stork provides an API to discover asset IDs from source market IDs,
 * this mapping must be maintained manually.
 *
 * Format:
 * - Key: sourceMarketId (from on-chain MarketCreated event)
 * - Value: Stork asset ID (used for WebSocket subscription and REST API)
 *
 * To add a new market:
 * 1. Get the Stork asset ID from Stork team
 * 2. Add mapping: 'your-source-market-id': 'STORK_ASSET_ID'
 * 3. Deploy the worker
 *
 * Example Stork asset IDs:
 * - PM_SB_2_8_26_KCC_Y = Polymarket Super Bowl 2/8/26 Kansas City Chiefs Yes
 * - PM_TOWD_25_WFG_Y = Polymarket Top Opening Weekend Domestic 2025 Wicked: For Good Yes
 */
export const MARKET_TO_STORK_ASSET: Record<string, string> = {
	// Super Bowl Champion 2026 - Kansas City Chiefs
	// Source: https://polymarket.com/event/super-bowl-champion-2026-731
	'super-bowl-champion-2026-kansas-city': 'PM_SB_2_8_26_KCC_Y',

	// Wicked: For Good - Biggest Movie Opening 2025
	// Source: https://polymarket.com/event/which-movie-has-best-opening-weekend-in-2025
	'wicked-for-good-opening-2025': 'PM_TOWD_25_WFG_Y',

	// Add more mappings as markets are created
	// 'source-market-id': 'STORK_ASSET_ID',
};

/**
 * Get Stork asset ID for a given source market ID
 * @param sourceMarketId - The source market ID from the blockchain event
 * @returns Stork asset ID or null if no mapping exists
 */
export function getStorkAssetId(sourceMarketId: string): string | null {
	return MARKET_TO_STORK_ASSET[sourceMarketId] || null;
}
