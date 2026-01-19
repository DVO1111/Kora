/**
 * KORA SPONSORED ACCOUNT TRACKER
 * 
 * This module answers the critical question:
 * "How do we DETERMINISTICALLY identify accounts created due to Kora sponsorship?"
 * 
 * ============================================================================
 * KORA vs NORMAL TRANSACTIONS - THE KEY DISTINCTION
 * ============================================================================
 * 
 * NORMAL OPERATOR TRANSACTION:
 *   - Operator is fee payer AND transaction authority
 *   - Operator creates accounts for THEMSELVES
 *   - Example: Operator swaps their own tokens
 * 
 * KORA-SPONSORED TRANSACTION:
 *   - Operator is ONLY the fee payer (accountKeys[0])
 *   - Operator is NOT the authority/owner of created accounts
 *   - User is the actual beneficiary of the transaction
 *   - Example: Operator pays fees for user's swap, user gets the ATA
 * 
 * ============================================================================
 * DETERMINISTIC IDENTIFICATION CRITERIA
 * ============================================================================
 * 
 * A Kora-sponsored account is identified by ALL of these conditions:
 * 
 * 1. FEE PAYER CHECK:
 *    - operator_pubkey === accountKeys[0] (fee payer position)
 *    - This means operator paid the transaction fees
 * 
 * 2. ACCOUNT CREATION CHECK:
 *    - Transaction contains CreateAccount, CreateAccountWithSeed, or CreateATA
 *    - New accounts were created in this transaction
 * 
 * 3. RENT SOURCE CHECK:
 *    - The "source" or "payer" field in the instruction === operator
 *    - Proves operator's SOL funded the rent, not just signed
 * 
 * 4. OWNERSHIP SEPARATION CHECK (Kora-specific):
 *    - The created account's owner/authority !== operator
 *    - This distinguishes sponsorship from self-transactions
 *    - For ATAs: wallet field !== operator
 *    - For system accounts: owner field !== operator (unless it's a program)
 * 
 * WHY THIS WORKS:
 * ===============
 * - If operator creates an account for THEMSELVES, they are the owner
 * - If operator SPONSORS an account for a USER, the user is the owner
 * - This ownership separation is the definitive marker of sponsorship
 * 
 * EDGE CASES HANDLED:
 * ===================
 * - Program-owned accounts (PDAs): Owner is a program, which is != operator
 * - Token accounts: wallet field shows the actual user who owns the ATA
 * - System accounts: Check if operator funded but doesn't own
 * 
 * ============================================================================
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
  /** Program that owns the account (e.g., Token Program, System Program) */
  owner: string;
  /** Account type: system, token, pda */
  accountType: "system" | "token" | "pda" | "unknown";
  /** Size of account data in bytes */
  dataSize: number;
  /** The Kora operator who PAID for this account's rent */
  sponsoredBy: string;
  /** 
   * The BENEFICIARY - the user who owns/controls this account.
   * This is the key field that proves sponsorship:
   * - If beneficiary === sponsoredBy, this is a self-transaction (NOT sponsorship)
   * - If beneficiary !== sponsoredBy, this IS a Kora-sponsored account
   */
  beneficiary: string;
  /** Current status */
  status: "active" | "empty" | "closed" | "unknown";
  /** Last time we checked this account */
  lastChecked?: number;
  /** Confidence that this is a Kora-sponsored account (not self-transaction) */
  sponsorshipConfidence: "high" | "medium" | "low";
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

  private getLockPath(): string {
    return this.registryPath + ".lock";
  }

  private acquireLock(): boolean {
    const lockPath = this.getLockPath();
    try {
      // Check if lock exists and is stale (older than 5 minutes)
      if (fs.existsSync(lockPath)) {
        const lockStat = fs.statSync(lockPath);
        const ageMs = Date.now() - lockStat.mtimeMs;
        if (ageMs < 5 * 60 * 1000) {
          // Lock is fresh, another process is running
          return false;
        }
        // Lock is stale, remove it
        fs.unlinkSync(lockPath);
      }
      // Create lock file
      fs.writeFileSync(lockPath, String(process.pid));
      return true;
    } catch {
      return false;
    }
  }

  private releaseLock(): void {
    const lockPath = this.getLockPath();
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Ignore errors releasing lock
    }
  }

  private saveRegistry(): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.registry.lastUpdated = new Date().toISOString();
    
    // Write to temp file first, then rename (atomic operation)
    const tempPath = this.registryPath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(this.registry, null, 2));
    fs.renameSync(tempPath, this.registryPath);
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
   * DETERMINISTIC IDENTIFICATION CRITERIA:
   * ======================================
   * 1. Operator is the fee payer (accountKeys[0])
   * 2. Transaction contains account creation instructions
   * 3. The rent/lamports source is the operator (payer field)
   * 4. The BENEFICIARY (account owner/wallet) is NOT the operator
   *    - This is the KEY check that distinguishes sponsorship from self-transactions
   * 
   * CONFIDENCE LEVELS:
   * ==================
   * - HIGH: Beneficiary clearly differs from operator (definite sponsorship)
   * - MEDIUM: Beneficiary is a program (PDA - likely sponsorship)
   * - LOW: Cannot determine beneficiary clearly
   */
  private extractSponsoredAccounts(
    tx: ParsedTransactionWithMeta,
    signature: string
  ): SponsoredAccount[] {
    const accounts: SponsoredAccount[] = [];

    // CRITERIA 1: Verify operator is fee payer (accountKeys[0])
    const feePayer = tx.transaction.message.accountKeys[0]?.pubkey;
    if (!feePayer || feePayer.toString() !== this.operatorAddress.toString()) {
      return accounts;
    }

    const blockTime = tx.blockTime || Math.floor(Date.now() / 1000);
    const operatorStr = this.operatorAddress.toString();

    // Analyze instructions for account creation
    for (const instruction of tx.transaction.message.instructions) {
      if (!("parsed" in instruction)) continue;

      const parsed = instruction.parsed;
      if (!parsed) continue;

      // System Program: CreateAccount
      if (instruction.program === "system" && parsed.type === "createAccount") {
        const info = parsed.info;
        
        // CRITERIA 3: Verify rent source is operator
        if (info.source !== operatorStr) continue;
        
        // CRITERIA 4: Determine beneficiary and check for sponsorship
        // For system CreateAccount, the newAccount owner determines the beneficiary
        const accountOwner = info.owner || "11111111111111111111111111111111";
        const beneficiary = this.determineBeneficiary(info.newAccount, accountOwner, operatorStr, tx);
        const confidence = this.calculateConfidence(beneficiary, operatorStr, accountOwner);
        
        // Skip if this looks like a self-transaction (operator creating for themselves)
        if (confidence === "low" && beneficiary === operatorStr) continue;
        
        accounts.push({
          address: info.newAccount,
          creationTxSignature: signature,
          createdAt: blockTime,
          rentLamports: info.lamports,
          owner: accountOwner,
          accountType: this.determineAccountType(accountOwner),
          dataSize: info.space || 0,
          sponsoredBy: operatorStr,
          beneficiary,
          status: "active",
          sponsorshipConfidence: confidence,
        });
      }

      // System Program: CreateAccountWithSeed
      if (instruction.program === "system" && parsed.type === "createAccountWithSeed") {
        const info = parsed.info;
        
        // CRITERIA 3: Verify rent source is operator
        if (info.source !== operatorStr) continue;
        
        const accountOwner = info.owner || "11111111111111111111111111111111";
        const beneficiary = info.base || accountOwner; // base is typically the user for seeded accounts
        const confidence = this.calculateConfidence(beneficiary, operatorStr, accountOwner);
        
        if (confidence === "low" && beneficiary === operatorStr) continue;
        
        accounts.push({
          address: info.newAccount,
          creationTxSignature: signature,
          createdAt: blockTime,
          rentLamports: info.lamports,
          owner: accountOwner,
          accountType: "pda",
          dataSize: info.space || 0,
          sponsoredBy: operatorStr,
          beneficiary,
          status: "active",
          sponsorshipConfidence: confidence,
        });
      }

      // SPL Associated Token Account: Create
      // This is the MOST COMMON Kora sponsorship case
      if (instruction.program === "spl-associated-token-account" && parsed.type === "create") {
        const info = parsed.info;
        
        // CRITERIA 3: Verify payer is operator
        if (info.payer !== operatorStr) continue;
        
        // CRITERIA 4: For ATAs, the "wallet" field IS the beneficiary
        // This is the definitive sponsorship check for ATAs
        const beneficiary = info.wallet;
        const confidence = this.calculateConfidence(beneficiary, operatorStr, TOKEN_PROGRAM_ID.toString());
        
        // If wallet === operator, this is NOT sponsorship (operator creating their own ATA)
        if (beneficiary === operatorStr) continue;
        
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
          sponsoredBy: operatorStr,
          beneficiary,
          status: "active",
          sponsorshipConfidence: confidence,
        });
      }
    }

    return accounts;
  }

  /**
   * Determine who benefits from this account (the actual user, not the sponsor)
   */
  private determineBeneficiary(
    accountAddress: string,
    accountOwner: string,
    operator: string,
    tx: ParsedTransactionWithMeta
  ): string {
    // If owner is a program, look for other signers who might be the beneficiary
    if (this.isProgram(accountOwner)) {
      // Look through signers (excluding fee payer) to find the user
      for (let i = 1; i < tx.transaction.message.accountKeys.length; i++) {
        const key = tx.transaction.message.accountKeys[i];
        if (key.signer && key.pubkey.toString() !== operator) {
          return key.pubkey.toString();
        }
      }
      return accountOwner; // Fall back to program owner
    }
    return accountOwner;
  }

  /**
   * Calculate confidence that this is a Kora-sponsored account
   */
  private calculateConfidence(
    beneficiary: string,
    operator: string,
    accountOwner: string
  ): SponsoredAccount["sponsorshipConfidence"] {
    // HIGH: Beneficiary is clearly a different wallet than operator
    if (beneficiary !== operator && !this.isProgram(beneficiary)) {
      return "high";
    }
    // MEDIUM: Owner is a program (PDAs are typically sponsorship)
    if (this.isProgram(accountOwner)) {
      return "medium";
    }
    // LOW: Cannot clearly determine
    return "low";
  }

  /**
   * Check if an address is a known program
   */
  private isProgram(address: string): boolean {
    const knownPrograms = [
      "11111111111111111111111111111111", // System Program
      TOKEN_PROGRAM_ID.toString(),
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Program
      "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", // Metaplex Token Metadata
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
      "ComputeBudget111111111111111111111111111111", // Compute Budget
    ];
    // Only return true for known programs, not arbitrary addresses
    return knownPrograms.includes(address);
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
        } else if (account.accountType === "token") {
          // For token accounts, check if balance is zero
          // Token account data layout: first 64 bytes are mint + owner, bytes 64-72 are amount
          if (info.data.length >= 72) {
            const amount = info.data.readBigUInt64LE(64);
            if (amount === 0n) {
              account.status = "empty";
              empty++;
            } else {
              account.status = "active";
              active++;
            }
          } else {
            account.status = "active";
            active++;
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

  /**
   * Get accounts that are empty/closed.
   * 
   * IMPORTANT: "Reclaimable" is misleading. These accounts are empty, but
   * you likely CANNOT reclaim them because:
   * - Token accounts are owned by users, not operators
   * - System accounts require owner signature
   * 
   * Use this for MONITORING what rent has been "released" when users close accounts.
   * The rent goes back to the USER who owned the account, not the operator who paid.
   */
  getReclaimableAccounts(): SponsoredAccount[] {
    return this.registry.accounts.filter(
      (a) => a.status === "empty" || a.status === "closed"
    );
  }

  /**
   * Get accounts where users have already closed them.
   * The rent was returned to the USER, not the operator.
   */
  getClosedAccounts(): SponsoredAccount[] {
    return this.registry.accounts.filter((a) => a.status === "closed");
  }

  /**
   * Get empty accounts (zero balance tokens, empty system accounts).
   * These could potentially be closed by users to recover rent.
   */
  getEmptyAccounts(): SponsoredAccount[] {
    return this.registry.accounts.filter((a) => a.status === "empty");
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

  /**
   * Execute an RPC call with exponential backoff for rate limits
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 1000
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        const message = lastError.message.toLowerCase();

        // Check if it's a rate limit error
        if (message.includes("429") || message.includes("rate") || message.includes("too many")) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.log(`   Rate limited, waiting ${delay}ms before retry...`);
          await this.sleep(delay);
        } else {
          // Not a rate limit error, don't retry
          throw error;
        }
      }
    }

    throw lastError;
  }
}
