/**
 * PHANTOM WALLET DEEP LINK INTEGRATION
 *
 * Generates deep links for Phantom wallet to sign transactions.
 * This allows users to reclaim their own accounts without sharing private keys.
 *
 * Flow:
 * 1. Bot creates unsigned transaction
 * 2. Bot generates Phantom deep link
 * 3. User clicks link, opens Phantom mobile app
 * 4. User approves transaction in Phantom
 * 5. Phantom signs and submits transaction
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";

// ============================================================================
// TYPES
// ============================================================================

export interface PhantomSession {
  /** Session keypair for encryption */
  keypair: nacl.BoxKeyPair;
  /** Phantom's public key (received after connect) */
  phantomPublicKey?: Uint8Array;
  /** Shared secret for decryption */
  sharedSecret?: Uint8Array;
}

export interface TokenAccountInfo {
  address: string;
  mint: string;
  balance: bigint;
  rentLamports: number;
  canClose: boolean;
  reason?: string;
}

export interface ReclaimTransaction {
  /** The unsigned transaction serialized as base64 */
  serializedTransaction: string;
  /** Phantom deep link URL */
  phantomUrl: string;
  /** Solflare deep link URL */
  solflareUrl: string;
  /** Number of accounts being closed */
  accountCount: number;
  /** Total rent to be reclaimed in lamports */
  totalRentLamports: number;
  /** Human readable total in SOL */
  totalSol: string;
}

// ============================================================================
// PHANTOM DEEP LINK GENERATOR
// ============================================================================

export class PhantomDeepLink {
  private connection: Connection;
  private cluster: "mainnet-beta" | "devnet" | "testnet";

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
    // Detect cluster from RPC URL
    if (rpcUrl.includes("devnet")) {
      this.cluster = "devnet";
    } else if (rpcUrl.includes("testnet")) {
      this.cluster = "testnet";
    } else {
      this.cluster = "mainnet-beta";
    }
  }

  /**
   * Find all empty token accounts owned by a wallet that can be closed
   */
  async findClosableTokenAccounts(walletAddress: string): Promise<TokenAccountInfo[]> {
    const wallet = new PublicKey(walletAddress);
    const closableAccounts: TokenAccountInfo[] = [];

    try {
      // Get all token accounts owned by this wallet
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(wallet, {
        programId: TOKEN_PROGRAM_ID,
      });

      for (const { pubkey, account } of tokenAccounts.value) {
        const parsed = account.data.parsed;
        const info = parsed.info;
        const balance = BigInt(info.tokenAmount.amount);
        const rentLamports = account.lamports;

        if (balance === 0n) {
          // Empty account - can be closed
          closableAccounts.push({
            address: pubkey.toBase58(),
            mint: info.mint,
            balance: 0n,
            rentLamports,
            canClose: true,
          });
        } else {
          // Has balance - cannot close without transferring first
          closableAccounts.push({
            address: pubkey.toBase58(),
            mint: info.mint,
            balance,
            rentLamports,
            canClose: false,
            reason: `Account has ${info.tokenAmount.uiAmountString} tokens`,
          });
        }
      }
    } catch (error) {
      console.error("Error fetching token accounts:", error);
      throw error;
    }

    return closableAccounts;
  }

  /**
   * Create a transaction to close empty token accounts
   */
  async createCloseAccountsTransaction(
    walletAddress: string,
    accountsToClose: string[],
    destinationAddress?: string
  ): Promise<ReclaimTransaction> {
    const wallet = new PublicKey(walletAddress);
    const destination = destinationAddress ? new PublicKey(destinationAddress) : wallet;

    if (accountsToClose.length === 0) {
      throw new Error("No accounts to close");
    }

    if (accountsToClose.length > 10) {
      throw new Error("Maximum 10 accounts per transaction. Please close in batches.");
    }

    // Create transaction
    const transaction = new Transaction();
    let totalRentLamports = 0;

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = wallet;

    // Add close instructions for each account
    for (const accountAddress of accountsToClose) {
      const accountPubkey = new PublicKey(accountAddress);

      // Verify the account exists and is empty
      try {
        const accountInfo = await getAccount(this.connection, accountPubkey);
        
        if (accountInfo.amount !== 0n) {
          throw new Error(`Account ${accountAddress} is not empty (balance: ${accountInfo.amount})`);
        }

        if (accountInfo.owner.toBase58() !== walletAddress) {
          throw new Error(`Account ${accountAddress} is not owned by ${walletAddress}`);
        }

        // Get rent amount
        const info = await this.connection.getAccountInfo(accountPubkey);
        if (info) {
          totalRentLamports += info.lamports;
        }

        // Add close instruction
        transaction.add(
          createCloseAccountInstruction(
            accountPubkey,  // Account to close
            destination,    // Destination for rent
            wallet,         // Owner/authority
            [],             // No multisig
            TOKEN_PROGRAM_ID
          )
        );
      } catch (error) {
        if (error instanceof TokenAccountNotFoundError) {
          throw new Error(`Token account ${accountAddress} not found`);
        }
        throw error;
      }
    }

    // Serialize transaction (unsigned)
    const serializedTransaction = transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");

    // Generate deep links
    const phantomUrl = this.generatePhantomSignUrl(serializedTransaction);
    const solflareUrl = this.generateSolflareSignUrl(serializedTransaction);

    return {
      serializedTransaction,
      phantomUrl,
      solflareUrl,
      accountCount: accountsToClose.length,
      totalRentLamports,
      totalSol: (totalRentLamports / LAMPORTS_PER_SOL).toFixed(6),
    };
  }

  /**
   * Generate Phantom deep link for signing a transaction
   * Uses the signAndSendTransaction action
   */
  private generatePhantomSignUrl(serializedTransaction: string): string {
    // URL-safe base64 encoding
    const encodedTx = encodeURIComponent(serializedTransaction);

    // Phantom universal link for sign and send
    // https://docs.phantom.app/developer-powertools/deeplinks-on-mobile
    const params = new URLSearchParams({
      transaction: serializedTransaction,
      cluster: this.cluster,
    });

    return `https://phantom.app/ul/v1/signAndSendTransaction?${params.toString()}`;
  }

  /**
   * Generate Solflare deep link for signing a transaction
   */
  private generateSolflareSignUrl(serializedTransaction: string): string {
    const params = new URLSearchParams({
      transaction: serializedTransaction,
      cluster: this.cluster,
    });

    return `https://solflare.com/ul/v1/signAndSendTransaction?${params.toString()}`;
  }

  /**
   * Generate a Solana Pay URL for the transaction
   * This works with any Solana Pay compatible wallet
   */
  generateSolanaPayUrl(serializedTransaction: string): string {
    // Solana Pay transaction request format
    const encodedTx = encodeURIComponent(serializedTransaction);
    return `solana:${encodedTx}`;
  }

  /**
   * Get summary of closable accounts for a wallet
   */
  async getWalletReclaimSummary(walletAddress: string): Promise<{
    closable: TokenAccountInfo[];
    nonClosable: TokenAccountInfo[];
    totalReclaimable: number;
    totalReclaimableSol: string;
  }> {
    const accounts = await this.findClosableTokenAccounts(walletAddress);
    
    const closable = accounts.filter(a => a.canClose);
    const nonClosable = accounts.filter(a => !a.canClose);
    const totalReclaimable = closable.reduce((sum, a) => sum + a.rentLamports, 0);

    return {
      closable,
      nonClosable,
      totalReclaimable,
      totalReclaimableSol: (totalReclaimable / LAMPORTS_PER_SOL).toFixed(6),
    };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Shorten an address for display
 */
export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Format lamports as SOL with symbol
 */
export function formatSolAmount(lamports: number): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  if (sol < 0.001) {
    return `${lamports} lamports`;
  }
  return `${sol.toFixed(6)} SOL`;
}
