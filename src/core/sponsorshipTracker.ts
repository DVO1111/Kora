/**
 * KORA SPONSORED ACCOUNT TRACKER
 * 
 * This module answers the critical question:
 * "These accounts were created because of Kora sponsorship."
 * 
 * HOW KORA SPONSORSHIP WORKS:
 * ===========================
 * 
 * 1. User submits a transaction to an app (e.g., swap, NFT mint)
 * 2. App routes the transaction through Kora's paymaster service
 * 3. Kora node (operator) signs as FEE PAYER
 * 4. Transaction creates new accounts (ATAs, PDAs, etc.)
 * 5. Operator's SOL pays for:
 *    - Transaction fees (small, ~0.000005 SOL)
 *    - RENT for new accounts (significant, 0.002+ SOL each)
 * 6. The rent SOL is now LOCKED in those accounts
 * 7. When accounts are no longer needed, rent can be reclaimed
 * 
 * IDENTIFYING SPONSORED ACCOUNTS:
 * ===============================
 * 
 * A sponsored account is identified by:
 * 1. Transaction where operator_pubkey is accountKeys[0] (fee payer)
 * 2. Transaction contains CreateAccount, InitializeAccount, or CreateATA instruction
 * 3. The lamports for rent came from the operator
 * 
 * This module provides:
 * - Transaction log ingestion
 * - Sponsored account registry (persistent)
 * - Deterministic discovery method
 */

import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// TYPES
// ============================================================================

export interface SponsoredAccount {
  /** The sponsored account address */
  address: string;
  /** Transaction signature that created this account */
  creationTxSignature: string;
  /** Block time when account was created */
  createdAt: number;
  /** Lamports locked as rent at creation */
  rentLamports: number;
  /** Program that owns the account */
  owner: string;
  /** Account type: system, token, pda */
  accountType: "system" | "token" | "pda" | "unknown";
  /** Size of account data in bytes */
  dataSize: number;
  /** The operator who sponsored this account */
  sponsoredBy: string;
  /** Current status */
  status: "active" | "empty" | "closed" | "unknown";
  /** Last time we checked this account */
  lastChecked?: number;
}

export interface SponsorshipRegistry {
  /** Operator address */
  operator: string;
  /** When this registry was created */
  createdAt: string;
  /** Last update time */
  lastUpdated: string;
  /** Last transaction signature we processed */
  lastProcessedSignature?: string;
  /** Total transactions processed */
  totalTransactionsProcessed: number;
  /** All sponsored accounts */
  accounts: SponsoredAccount[];
  /** Historical metrics */
  metrics: {
    totalAccountsSponsored: number;
    totalRentLocked: number;
    totalRentReclaimed: number;
    totalAccountsClosed: number;
  };
}

// ============================================================================
// KORA SPONSORSHIP TRACKER
// ============================================================================

export class KoraSponsorshipTracker {
  private connection: Connection;
  private operatorAddress: PublicKey;
  private registryPath: string;
  private registry: SponsorshipRegistry;

  constructor(
    rpcUrl: string,
    operatorAddress: string,
    registryPath: string = "./data/sponsorship-registry.json"
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.operatorAddress = new PublicKey(operatorAddress);
    this.registryPath = registryPath;
    this.registry = this.loadOrCreateRegistry();
  }

  // ==========================================================================
  // REGISTRY PERSISTENCE
  // ==========================================================================

  private loadOrCreateRegistry(): SponsorshipRegistry {
    if (fs.existsSync(this.registryPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.registryPath, "utf-8"));
      } catch {
        console.log("Warning: Failed to load registry, creating new one");
      }
    }

    return {
      operator: this.operatorAddress.toString(),
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      totalTransactionsProcessed: 0,
      accounts: [],
      metrics: {
        totalAccountsSponsored: 0,
        totalRentLocked: 0,
        totalRentReclaimed: 0,
        totalAccountsClosed: 0,
      },
    };
  }

  private saveRegistry(): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.registry.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.registryPath, JSON.stringify(this.registry, null, 2));
  }

  // ==========================================================================
  // TRANSACTION LOG INGESTION
  // ==========================================================================

  /**
   * Ingest transaction history and extract sponsored accounts.
   * This is the DETERMINISTIC method to discover sponsored accounts.
   * 
   * Process:
   * 1. Fetch transactions where operator was fee payer
   * 2. Parse each transaction for account creation instructions
   * 3. Record sponsored accounts in persistent registry
   */
  async ingestTransactionHistory(
    limit: number = 1000,
    onProgress?: (processed: number, found: number) => void
  ): Promise<{
    transactionsProcessed: number;
    newAccountsFound: number;
    errors: number;
  }> {
    let transactionsProcessed = 0;
    let newAccountsFound = 0;
    let errors = 0;

    console.log(`\nIngesting transaction history for operator...`);
    console.log(`   Operator: ${this.operatorAddress.toString()}`);
    console.log(`   Starting from: ${this.registry.lastProcessedSignature || "beginning"}`);

    try {
      // Fetch transaction signatures
      const signatures = await this.connection.getSignaturesForAddress(
        this.operatorAddress,
        {
          limit,
          before: undefined, // Start from most recent
        }
      );

      console.log(`   Found ${signatures.length} transactions to process\n`);

      // Process transactions in small batches
      const batchSize = 5;
      for (let i = 0; i < signatures.length; i += batchSize) {
        const batch = signatures.slice(i, i + batchSize);

        for (const sigInfo of batch) {
          try {
            // Skip if already processed
            if (this.isSignatureProcessed(sigInfo.signature)) {
              transactionsProcessed++;
              continue;
            }

            const tx = await this.connection.getParsedTransaction(
              sigInfo.signature,
              { maxSupportedTransactionVersion: 0 }
            );

            if (tx && !tx.meta?.err) {
              const sponsored = this.extractSponsoredAccounts(tx, sigInfo.signature);
              
              for (const account of sponsored) {
                if (!this.isAccountTracked(account.address)) {
                  this.registry.accounts.push(account);
                  this.registry.metrics.totalAccountsSponsored++;
                  this.registry.metrics.totalRentLocked += account.rentLamports;
                  newAccountsFound++;
                }
              }
            }

            transactionsProcessed++;
            this.registry.totalTransactionsProcessed++;

          } catch (error) {
            errors++;
          }
        }

        // Update progress
        if (onProgress) {
          onProgress(transactionsProcessed, newAccountsFound);
        }

        // Rate limiting
        await this.sleep(300);
      }

      // Save last processed signature
      if (signatures.length > 0) {
        this.registry.lastProcessedSignature = signatures[signatures.length - 1].signature;
      }

      this.saveRegistry();

    } catch (error) {
      console.error(`   Ingestion error: ${(error as Error).message}`);
    }

    return { transactionsProcessed, newAccountsFound, errors };
  }

  /**
   * Extract sponsored accounts from a parsed transaction.
   * 
   * IDENTIFICATION CRITERIA:
   * 1. Our operator is the fee payer (accountKeys[0])
   * 2. Transaction contains account creation instructions
   * 3. Rent lamports came from the fee payer
   */
  private extractSponsoredAccounts(
    tx: ParsedTransactionWithMeta,
    signature: string
  ): SponsoredAccount[] {
    const accounts: SponsoredAccount[] = [];

    // Verify operator is fee payer
    const feePayer = tx.transaction.message.accountKeys[0]?.pubkey;
    if (!feePayer || feePayer.toString() !== this.operatorAddress.toString()) {
      return accounts;
    }

    const blockTime = tx.blockTime || Math.floor(Date.now() / 1000);

    // Analyze instructions for account creation
    for (const instruction of tx.transaction.message.instructions) {
      if (!("parsed" in instruction)) continue;

      const parsed = instruction.parsed;
      if (!parsed) continue;

      // System Program: CreateAccount
      if (instruction.program === "system" && parsed.type === "createAccount") {
        const info = parsed.info;
        accounts.push({
          address: info.newAccount,
          creationTxSignature: signature,
          createdAt: blockTime,
          rentLamports: info.lamports,
          owner: info.owner || "11111111111111111111111111111111",
          accountType: this.determineAccountType(info.owner),
          dataSize: info.space || 0,
          sponsoredBy: this.operatorAddress.toString(),
          status: "active",
        });
      }

      // System Program: CreateAccountWithSeed
      if (instruction.program === "system" && parsed.type === "createAccountWithSeed") {
        const info = parsed.info;
        accounts.push({
          address: info.newAccount,
          creationTxSignature: signature,
          createdAt: blockTime,
          rentLamports: info.lamports,
          owner: info.owner || "11111111111111111111111111111111",
          accountType: "pda",
          dataSize: info.space || 0,
          sponsoredBy: this.operatorAddress.toString(),
          status: "active",
        });
      }

      // SPL Associated Token Account: Create
      if (instruction.program === "spl-associated-token-account" && parsed.type === "create") {
        const info = parsed.info;
        // ATA rent is always 0.00203928 SOL (165 bytes)
        const ataRent = 2039280;
        accounts.push({
          address: info.account,
          creationTxSignature: signature,
          createdAt: blockTime,
          rentLamports: ataRent,
          owner: TOKEN_PROGRAM_ID.toString(),
          accountType: "token",
          dataSize: 165,
          sponsoredBy: this.operatorAddress.toString(),
          status: "active",
        });
      }
    }

    return accounts;
  }

  private determineAccountType(owner: string | undefined): SponsoredAccount["accountType"] {
    if (!owner) return "system";
    if (owner === TOKEN_PROGRAM_ID.toString()) return "token";
    if (owner === "11111111111111111111111111111111") return "system";
    return "pda";
  }

  private isSignatureProcessed(signature: string): boolean {
    return this.registry.accounts.some((a) => a.creationTxSignature === signature);
  }

  private isAccountTracked(address: string): boolean {
    return this.registry.accounts.some((a) => a.address === address);
  }

  // ==========================================================================
  // ACCOUNT STATUS REFRESH
  // ==========================================================================

  /**
   * Refresh the status of all tracked accounts.
   * Updates: active, empty, or closed
   */
  async refreshAccountStatuses(
    onProgress?: (checked: number, total: number) => void
  ): Promise<{
    active: number;
    empty: number;
    closed: number;
    updated: number;
  }> {
    let active = 0;
    let empty = 0;
    let closed = 0;
    let updated = 0;

    const total = this.registry.accounts.length;
    console.log(`\nRefreshing status of ${total} tracked accounts...`);

    for (let i = 0; i < this.registry.accounts.length; i++) {
      const account = this.registry.accounts[i];

      try {
        const pubkey = new PublicKey(account.address);
        const info = await this.connection.getAccountInfo(pubkey);

        const oldStatus = account.status;

        if (!info) {
          account.status = "closed";
          closed++;
          if (oldStatus !== "closed") {
            this.registry.metrics.totalAccountsClosed++;
          }
        } else if (info.data.length === 0 || info.data.every((b) => b === 0)) {
          account.status = "empty";
          empty++;
        } else {
          account.status = "active";
          active++;
        }

        if (oldStatus !== account.status) {
          updated++;
        }

        account.lastChecked = Date.now();

        if (onProgress) {
          onProgress(i + 1, total);
        }

      } catch {
        // Keep existing status on error
      }

      // Rate limiting
      if (i % 10 === 0) {
        await this.sleep(200);
      }
    }

    this.saveRegistry();

    return { active, empty, closed, updated };
  }

  // ==========================================================================
  // GETTERS
  // ==========================================================================

  getRegistry(): SponsorshipRegistry {
    return this.registry;
  }

  getSponsoredAccounts(): SponsoredAccount[] {
    return this.registry.accounts;
  }

  getReclaimableAccounts(): SponsoredAccount[] {
    return this.registry.accounts.filter(
      (a) => a.status === "empty" || a.status === "closed"
    );
  }

  getActiveAccounts(): SponsoredAccount[] {
    return this.registry.accounts.filter((a) => a.status === "active");
  }

  getMetrics(): SponsorshipRegistry["metrics"] {
    return this.registry.metrics;
  }

  /**
   * Record a successful reclaim
   */
  recordReclaim(address: string, lamportsReclaimed: number): void {
    const account = this.registry.accounts.find((a) => a.address === address);
    if (account) {
      account.status = "closed";
      this.registry.metrics.totalRentReclaimed += lamportsReclaimed;
      this.registry.metrics.totalAccountsClosed++;
      this.saveRegistry();
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
