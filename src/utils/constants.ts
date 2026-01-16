/**
 * Solana network and program constants
 */

export const NETWORKS = {
  MAINNET: {
    name: "mainnet-beta",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    explorerUrl: "https://explorer.solana.com",
    solscanUrl: "https://solscan.io",
  },
  DEVNET: {
    name: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    explorerUrl: "https://explorer.solana.com?cluster=devnet",
    solscanUrl: "https://solscan.io?cluster=devnet",
  },
  TESTNET: {
    name: "testnet",
    rpcUrl: "https://api.testnet.solana.com",
    explorerUrl: "https://explorer.solana.com?cluster=testnet",
    solscanUrl: "https://solscan.io?cluster=testnet",
  },
} as const;

/**
 * Common Solana programs
 */
export const PROGRAMS = {
  SYSTEM: "11111111111111111111111111111111",
  TOKEN: "TokenkegQfeZyiNwAJsyFbPVwwQkYk5modlYKYro8t",
  TOKEN_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ASSOCIATED_TOKEN: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  MEMO: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  COMPUTE_BUDGET: "ComputeBudget111111111111111111111111111111",
} as const;

/**
 * Solana rent constants (approximate, as of Jan 2025)
 */
export const RENT = {
  BYTES_PER_ACCOUNT_OVERHEAD: 128,
  LAMPORTS_PER_BYTE_YEAR: 3480, // ~3.48 SOL per MB per year
  EXEMPTION_THRESHOLD_YEARS: 2, // Accounts must hold 2 years of rent to be exempt
} as const;

/**
 * Common account sizes (in bytes)
 */
export const ACCOUNT_SIZES = {
  TOKEN_ACCOUNT: 165,
  TOKEN_MINT: 82,
  MULTISIG: 355,
  ACCOUNT_METADATA: 128,
} as const;

/**
 * Calculate rent for a given data size
 */
export function calculateRentLamports(dataSize: number): number {
  const totalBytes = dataSize + RENT.BYTES_PER_ACCOUNT_OVERHEAD;
  return Math.ceil(
    (totalBytes * RENT.LAMPORTS_PER_BYTE_YEAR * RENT.EXEMPTION_THRESHOLD_YEARS)
  );
}

/**
 * Common token account rent (for quick reference)
 */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = calculateRentLamports(
  ACCOUNT_SIZES.TOKEN_ACCOUNT
);

/**
 * Default bot configuration values
 */
export const DEFAULTS = {
  MONITOR_INTERVAL_MINUTES: 5,
  MIN_RENT_TO_RECLAIM_SOL: 0.002,
  MAX_RECLAIM_PER_BATCH: 10,
  MIN_ACCOUNT_AGE_DAYS: 30,
  RPC_COMMITMENT: "confirmed",
  LOG_LEVEL: "info",
} as const;

/**
 * Rate limiting constants
 */
export const RATE_LIMITS = {
  MAX_RPC_CALLS_PER_SECOND: 10,
  BATCH_DELAY_MS: 1000,
  RETRY_DELAY_MS: 1000,
  MAX_RETRIES: 3,
} as const;

/**
 * Transaction fee constants
 */
export const TX_FEES = {
  LAMPORTS_PER_SIGNATURE: 5000,
  PRIORITY_FEE_MICROLAMPORTS: 1000,
} as const;
