import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

/**
 * Convert lamports to SOL
 */
export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Convert SOL to lamports
 */
export function solToLamports(sol: number): number {
  return sol * LAMPORTS_PER_SOL;
}

/**
 * Validate a Solana public key
 */
export function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format SOL amount for display
 */
export function formatSol(sol: number, decimals: number = 4): string {
  return sol.toFixed(decimals);
}

/**
 * Format lamports as SOL for display
 */
export function formatLamportsAsSol(
  lamports: number,
  decimals: number = 4
): string {
  return formatSol(lamportsToSol(lamports), decimals);
}

/**
 * Truncate a Solana address for display
 */
export function truncateAddress(
  address: string,
  startChars: number = 4,
  endChars: number = 4
): string {
  if (address.length <= startChars + endChars + 3) {
    return address;
  }
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }

  throw lastError!;
}

/**
 * Chunk an array into smaller arrays
 */
export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Calculate percentage
 */
export function calculatePercentage(
  part: number,
  total: number,
  decimals: number = 2
): string {
  if (total === 0) return "0.00";
  return ((part / total) * 100).toFixed(decimals);
}

/**
 * Format date as ISO string (short)
 */
export function formatDateShort(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Format date with time
 */
export function formatDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Calculate days between two dates
 */
export function daysBetween(date1: Date, date2: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor(
    (Math.abs(date2.getTime() - date1.getTime())) / msPerDay
  );
}

/**
 * Generate a random ID
 */
export function generateId(length: number = 8): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Parse account list from various formats
 */
export function parseAccountList(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    return input.filter(isValidPublicKey);
  }

  // Try parsing as JSON array
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      return parsed.filter(isValidPublicKey);
    }
  } catch {
    // Not JSON, try splitting by common delimiters
  }

  // Split by comma, newline, or space
  return input
    .split(/[,\n\s]+/)
    .map((s) => s.trim())
    .filter(isValidPublicKey);
}

/**
 * Estimate transaction fee in SOL
 */
export function estimateTransactionFee(
  signatureCount: number = 1,
  lamportsPerSignature: number = 5000
): number {
  return lamportsToSol(signatureCount * lamportsPerSignature);
}

/**
 * Constants for Solana programs
 */
export const SOLANA_PROGRAMS = {
  SYSTEM_PROGRAM: "11111111111111111111111111111111",
  TOKEN_PROGRAM: "TokenkegQfeZyiNwAJsyFbPVwwQkYk5modlYKYro8t",
  TOKEN_2022_PROGRAM: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ASSOCIATED_TOKEN_PROGRAM: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
};

/**
 * Check if a program ID is a token program
 */
export function isTokenProgram(programId: string): boolean {
  return (
    programId === SOLANA_PROGRAMS.TOKEN_PROGRAM ||
    programId === SOLANA_PROGRAMS.TOKEN_2022_PROGRAM
  );
}
