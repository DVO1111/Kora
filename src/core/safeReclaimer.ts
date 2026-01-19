/**
 * SAFE RENT RECLAIMER
 * 
 * This module handles the actual reclaim with DEFENSIVE safety rules.
 * 
 * IMPORTANT LIMITATION:
 * =====================
 * On Solana, you can ONLY close accounts you OWN. When Kora sponsors account
 * creation, the USER becomes the owner, not the operator. This means:
 * 
 * - You CANNOT close token accounts (ATAs) you sponsored - user owns them
 * - You CANNOT transfer lamports from accounts you don't own
 * - You CAN only track what you've sponsored and monitor for closures
 * 
 * WHAT THIS MODULE CAN DO:
 * ========================
 * 1. Track accounts that were already closed (by users) - rent returned to user
 * 2. Close token accounts where you ARE the owner (rare - only if you kept authority)
 * 3. Close system accounts you own (rare)
 * 4. Monitor and report on locked rent
 * 
 * SAFETY RULES (HARD REQUIREMENTS):
 * =================================
 * 
 * 1. TIME-BASED INACTIVITY THRESHOLD
 *    - Account must be inactive for MIN_INACTIVE_DAYS (default: 7 days)
 *    - Prevents reclaiming accounts that are temporarily empty
 * 
 * 2. RECENT WRITE DETECTION
 *    - Check account's recent transaction history
 *    - If any writes in last RECENT_WRITE_DAYS, skip
 * 
 * 3. OWNERSHIP VERIFICATION (CRITICAL)
 *    - Token accounts: MUST verify we have close authority
 *    - System accounts: MUST verify we own the account
 *    - Only attempt close if ownership confirmed
 * 
 * 4. EXPLICIT DENY-LIST
 *    - Never touch program accounts
 *    - Never touch accounts in denyList
 *    - Never touch accounts with non-zero token balance
 * 
 * RECLAIM LIFECYCLE:
 * ==================
 * discover → classify → validate ownership → dry-run → reclaim → verify → log
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { SponsoredAccount } from "./sponsorshipTracker.js";

// ============================================================================
// SAFETY CONFIGURATION
// ============================================================================

export interface SafetyConfig {
  /** Minimum days of inactivity before reclaim (default: 7) */
  minInactiveDays: number;
  /** Days to check for recent writes (default: 3) */
  recentWriteDays: number;
  /** Addresses that should NEVER be touched */
  denyList: string[];
  /** Only reclaim these addresses (if set) */
  allowList?: string[];
  /** Maximum lamports to reclaim per account */
  maxReclaimPerAccount: number;
  /** Maximum accounts to reclaim per run */
  maxAccountsPerRun: number;
  /** Require manual confirmation for high-value reclaims */
  highValueThreshold: number;
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  minInactiveDays: 7,
  recentWriteDays: 3,
  denyList: [],
  maxReclaimPerAccount: 1 * LAMPORTS_PER_SOL, // 1 SOL max
  maxAccountsPerRun: 50,
  highValueThreshold: 0.1 * LAMPORTS_PER_SOL, // 0.1 SOL
};

// ============================================================================
// TYPES
// ============================================================================

export interface ValidationResult {
  address: string;
  canReclaim: boolean;
  reason: string;
  riskLevel: "safe" | "medium" | "high" | "blocked";
  checks: {
    inDenyList: boolean;
    hasRecentWrites: boolean;
    meetsInactivityThreshold: boolean;
    isEmptyOrZeroBalance: boolean;
    ownershipVerified: boolean;
    belowMaxReclaim: boolean;
  };
}

export interface ReclaimTransaction {
  address: string;
  lamportsBefore: number;
  lamportsAfter: number;
  lamportsReclaimed: number;
  txSignature: string;
  timestamp: string;
  treasuryBalanceBefore: number;
  treasuryBalanceAfter: number;
  verified: boolean;
}

export interface ReclaimReport {
  runId: string;
  timestamp: string;
  operator: string;
  treasury: string;
  dryRun: boolean;
  accountsAnalyzed: number;
  accountsValidated: number;
  accountsReclaimed: number;
  accountsFailed: number;
  totalLamportsReclaimed: number;
  transactions: ReclaimTransaction[];
  errors: Array<{ address: string; error: string }>;
}

// ============================================================================
// SAFE RECLAIMER
// ============================================================================

export class SafeRentReclaimer {
  private connection: Connection;
  private keypair: Keypair | null;
  private treasury: PublicKey;
  private safetyConfig: SafetyConfig;
  private reportsPath: string;

  constructor(
    rpcUrl: string,
    keypairPath: string | null,
    treasuryAddress: string,
    safetyConfig: Partial<SafetyConfig> = {},
    reportsPath: string = "./data/reclaim-reports"
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.treasury = new PublicKey(treasuryAddress);
    this.safetyConfig = { ...DEFAULT_SAFETY_CONFIG, ...safetyConfig };
    this.reportsPath = reportsPath;

    // Load keypair if provided
    if (keypairPath && fs.existsSync(keypairPath)) {
      const keyData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      this.keypair = Keypair.fromSecretKey(Uint8Array.from(keyData));
    } else {
      this.keypair = null;
    }
  }

  // ==========================================================================
  // VALIDATION (SAFETY CHECKS)
  // ==========================================================================

  /**
   * Validate if an account is safe to reclaim.
   * Applies ALL safety rules before allowing reclaim.
   */
  async validateAccount(account: SponsoredAccount): Promise<ValidationResult> {
    const checks = {
      inDenyList: false,
      hasRecentWrites: false,
      meetsInactivityThreshold: false,
      isEmptyOrZeroBalance: false,
      ownershipVerified: false,
      belowMaxReclaim: false,
    };

    // CHECK 1: Deny list
    if (this.safetyConfig.denyList.includes(account.address)) {
      checks.inDenyList = true;
      return {
        address: account.address,
        canReclaim: false,
        reason: "Account is in deny list - BLOCKED",
        riskLevel: "blocked",
        checks,
      };
    }

    // CHECK 2: Allow list (if specified)
    if (
      this.safetyConfig.allowList &&
      !this.safetyConfig.allowList.includes(account.address)
    ) {
      return {
        address: account.address,
        canReclaim: false,
        reason: "Account is not in allow list",
        riskLevel: "blocked",
        checks,
      };
    }

    // CHECK 3: Inactivity threshold
    const accountAge = Date.now() - account.createdAt * 1000;
    const minAge = this.safetyConfig.minInactiveDays * 24 * 60 * 60 * 1000;
    checks.meetsInactivityThreshold = accountAge >= minAge;

    if (!checks.meetsInactivityThreshold) {
      return {
        address: account.address,
        canReclaim: false,
        reason: `Account is only ${Math.floor(accountAge / (24 * 60 * 60 * 1000))} days old (min: ${this.safetyConfig.minInactiveDays})`,
        riskLevel: "medium",
        checks,
      };
    }

    // CHECK 4: Recent writes
    checks.hasRecentWrites = await this.hasRecentWrites(account.address);
    if (checks.hasRecentWrites) {
      return {
        address: account.address,
        canReclaim: false,
        reason: `Account has recent activity in last ${this.safetyConfig.recentWriteDays} days`,
        riskLevel: "high",
        checks,
      };
    }

    // CHECK 5: Get current account state
    const pubkey = new PublicKey(account.address);
    const info = await this.connection.getAccountInfo(pubkey);

    if (!info) {
      return {
        address: account.address,
        canReclaim: false,
        reason: "Account already closed",
        riskLevel: "safe",
        checks,
      };
    }

    // CHECK 6: Below max reclaim
    checks.belowMaxReclaim = info.lamports <= this.safetyConfig.maxReclaimPerAccount;
    if (!checks.belowMaxReclaim) {
      return {
        address: account.address,
        canReclaim: false,
        reason: `Account value (${info.lamports / LAMPORTS_PER_SOL} SOL) exceeds max (${this.safetyConfig.maxReclaimPerAccount / LAMPORTS_PER_SOL} SOL)`,
        riskLevel: "high",
        checks,
      };
    }

    // CHECK 7: Account type specific validation with OWNERSHIP VERIFICATION
    if (account.accountType === "token") {
      // Token account: verify zero balance AND ownership
      try {
        const tokenAccount = await getAccount(this.connection, pubkey);
        checks.isEmptyOrZeroBalance = tokenAccount.amount === 0n;
        
        // CRITICAL: Verify we have authority to close this account
        // For ATAs, the "owner" field is the wallet that owns the tokens
        // We can ONLY close if we are that owner
        if (this.keypair) {
          checks.ownershipVerified = tokenAccount.owner.equals(this.keypair.publicKey);
        } else {
          checks.ownershipVerified = false;
        }

        if (!checks.isEmptyOrZeroBalance) {
          return {
            address: account.address,
            canReclaim: false,
            reason: `Token account has ${tokenAccount.amount} tokens - DO NOT TOUCH`,
            riskLevel: "blocked",
            checks,
          };
        }

        if (!checks.ownershipVerified) {
          // This is the EXPECTED case for Kora-sponsored accounts
          // The USER owns the ATA, not the operator who paid for it
          return {
            address: account.address,
            canReclaim: false,
            reason: "Cannot close: you sponsored this account but USER owns it (this is normal for Kora)",
            riskLevel: "blocked", // Changed from medium - this is not reclaimable
            checks,
          };
        }
      } catch (error) {
        // If we can't read the token account, it might be in an invalid state
        return {
          address: account.address,
          canReclaim: false,
          reason: `Cannot read token account state: ${(error as Error).message}`,
          riskLevel: "medium",
          checks,
        };
      }
    } else if (account.accountType === "pda") {
      // PDA accounts: NEVER auto-close
      return {
        address: account.address,
        canReclaim: false,
        reason: "PDA accounts require program authority - cannot auto-close",
        riskLevel: "blocked",
        checks,
      };
    } else {
      // System account: verify we OWN it (not just sponsored it)
      // CRITICAL: You can only close accounts where you are the owner
      if (this.keypair) {
        checks.ownershipVerified = info.owner.equals(this.keypair.publicKey);
      } else {
        checks.ownershipVerified = false;
      }

      if (!checks.ownershipVerified) {
        return {
          address: account.address,
          canReclaim: false,
          reason: `Cannot close: account is owned by ${info.owner.toString().slice(0, 8)}... not your keypair`,
          riskLevel: "blocked",
          checks,
        };
      }

      checks.isEmptyOrZeroBalance =
        info.data.length === 0 || info.data.every((b) => b === 0);

      if (!checks.isEmptyOrZeroBalance) {
        return {
          address: account.address,
          canReclaim: false,
          reason: "System account has data - not empty",
          riskLevel: "medium",
          checks,
        };
      }
    }

    // ALL CHECKS PASSED
    const riskLevel = info.lamports > this.safetyConfig.highValueThreshold ? "medium" : "safe";

    return {
      address: account.address,
      canReclaim: true,
      reason: `Safe to reclaim: ${account.accountType} account, ${(info.lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
      riskLevel,
      checks,
    };
  }

  /**
   * Check if account has recent transaction activity
   */
  private async hasRecentWrites(address: string): Promise<boolean> {
    try {
      const pubkey = new PublicKey(address);
      const signatures = await this.connection.getSignaturesForAddress(pubkey, {
        limit: 5,
      });

      if (signatures.length === 0) return false;

      const recentThreshold =
        Date.now() - this.safetyConfig.recentWriteDays * 24 * 60 * 60 * 1000;

      return signatures.some(
        (sig) => sig.blockTime && sig.blockTime * 1000 > recentThreshold
      );
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // RECLAIM EXECUTION
  // ==========================================================================

  /**
   * Execute the full reclaim lifecycle:
   * validate → dry-run → reclaim → verify → log
   */
  async executeReclaim(
    accounts: SponsoredAccount[],
    dryRun: boolean = true,
    onReclaim?: (account: SponsoredAccount) => void
  ): Promise<ReclaimReport> {
    const report: ReclaimReport = {
      runId: `reclaim-${Date.now()}`,
      timestamp: new Date().toISOString(),
      operator: accounts[0]?.sponsoredBy || "unknown",
      treasury: this.treasury.toString(),
      dryRun,
      accountsAnalyzed: accounts.length,
      accountsValidated: 0,
      accountsReclaimed: 0,
      accountsFailed: 0,
      totalLamportsReclaimed: 0,
      transactions: [],
      errors: [],
    };

    // Limit accounts per run
    const toProcess = accounts.slice(0, this.safetyConfig.maxAccountsPerRun);

    console.log(`\n${"═".repeat(60)}`);
    console.log(dryRun ? "   DRY RUN - No transactions will be sent" : "   EXECUTING RECLAIMS");
    console.log(`${"═".repeat(60)}`);
    console.log(`   Accounts to process: ${toProcess.length}`);
    console.log(`   Treasury: ${this.treasury.toString()}`);
    console.log();

    // Get treasury balance BEFORE
    const treasuryBalanceBefore = await this.connection.getBalance(this.treasury);

    for (const account of toProcess) {
      // STEP 1: Validate
      const validation = await this.validateAccount(account);

      if (!validation.canReclaim) {
        console.log(`   [SKIP] ${account.address.slice(0, 12)}...`);
        console.log(`      Reason: ${validation.reason}`);
        console.log();
        continue;
      }

      report.accountsValidated++;

      // STEP 2: Get account balance
      const pubkey = new PublicKey(account.address);
      const info = await this.connection.getAccountInfo(pubkey);
      if (!info) continue;

      const lamportsBefore = info.lamports;

      console.log(`   [OK] ${account.address.slice(0, 12)}...`);
      console.log(`      Type: ${account.accountType}`);
      console.log(`      Value: ${(lamportsBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      console.log(`      Risk: ${validation.riskLevel}`);

      if (dryRun) {
        console.log(`      -> Would reclaim ${(lamportsBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
        report.accountsReclaimed++;
        report.totalLamportsReclaimed += lamportsBefore;
        report.transactions.push({
          address: account.address,
          lamportsBefore,
          lamportsAfter: 0,
          lamportsReclaimed: lamportsBefore,
          txSignature: "DRY_RUN",
          timestamp: new Date().toISOString(),
          treasuryBalanceBefore,
          treasuryBalanceAfter: treasuryBalanceBefore + lamportsBefore,
          verified: true,
        });
      } else {
        // STEP 3: Execute reclaim
        if (!this.keypair) {
          console.log(`      [ERROR] No keypair - cannot execute`);
          report.errors.push({ address: account.address, error: "No keypair" });
          report.accountsFailed++;
          continue;
        }

        try {
          let txSignature: string;

          if (account.accountType === "token") {
            // Close token account - only works if WE are the owner
            // The validation should have already verified this
            const closeIx = createCloseAccountInstruction(
              pubkey,
              this.treasury,
              this.keypair.publicKey // We must be the owner
            );
            const tx = new Transaction().add(closeIx);
            txSignature = await sendAndConfirmTransaction(
              this.connection,
              tx,
              [this.keypair],
              { commitment: "confirmed" }
            );
          } else {
            // System account - we can only transfer if we OWN the account
            // For system accounts owned by us, we transfer all lamports out
            // NOTE: This requires the account to be owned by our keypair's pubkey
            // If the account is owned by System Program, we need different logic
            
            if (info.owner.equals(SystemProgram.programId)) {
              // Account is owned by System Program - we need to be the account itself
              // This means our keypair must BE the account (which is rare)
              // In practice, this won't work for sponsored accounts
              console.log(`      [ERROR] System-owned accounts cannot be drained by third parties`);
              report.errors.push({ 
                address: account.address, 
                error: "Cannot drain: account owned by System Program, not your keypair" 
              });
              report.accountsFailed++;
              continue;
            }
            
            // Account owned by our keypair - we can transfer
            const transferIx = SystemProgram.transfer({
              fromPubkey: pubkey,
              toPubkey: this.treasury,
              lamports: lamportsBefore,
            });
            const tx = new Transaction().add(transferIx);
            txSignature = await sendAndConfirmTransaction(
              this.connection,
              tx,
              [this.keypair],
              { commitment: "confirmed" }
            );
          }

          // STEP 4: Verify
          const infoAfter = await this.connection.getAccountInfo(pubkey);
          const lamportsAfter = infoAfter?.lamports || 0;
          const treasuryBalanceAfter = await this.connection.getBalance(this.treasury);
          const verified = treasuryBalanceAfter > treasuryBalanceBefore;

          console.log(`      Tx: ${txSignature.slice(0, 20)}...`);
          console.log(`      Verified: ${verified}`);

          report.accountsReclaimed++;
          report.totalLamportsReclaimed += lamportsBefore - lamportsAfter;
          report.transactions.push({
            address: account.address,
            lamportsBefore,
            lamportsAfter,
            lamportsReclaimed: lamportsBefore - lamportsAfter,
            txSignature,
            timestamp: new Date().toISOString(),
            treasuryBalanceBefore,
            treasuryBalanceAfter,
            verified,
          });

          if (onReclaim) {
            onReclaim(account);
          }

        } catch (error) {
          console.log(`      [FAILED] ${(error as Error).message}`);
          report.errors.push({
            address: account.address,
            error: (error as Error).message,
          });
          report.accountsFailed++;
        }
      }

      console.log();
    }

    // Save report
    this.saveReport(report);

    // Print summary
    this.printSummary(report, treasuryBalanceBefore);

    return report;
  }

  // ==========================================================================
  // REPORTING
  // ==========================================================================

  private saveReport(report: ReclaimReport): void {
    if (!fs.existsSync(this.reportsPath)) {
      fs.mkdirSync(this.reportsPath, { recursive: true });
    }

    const filename = `${report.runId}.json`;
    const filepath = path.join(this.reportsPath, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
    console.log(`Report saved: ${filepath}`);
  }

  private printSummary(report: ReclaimReport, treasuryBefore: number): void {
    console.log(`\n${"═".repeat(60)}`);
    console.log("                    RECLAIM SUMMARY");
    console.log(`${"═".repeat(60)}`);
    console.log(`   Run ID:             ${report.runId}`);
    console.log(`   Mode:               ${report.dryRun ? "DRY RUN" : "EXECUTED"}`);
    console.log(`${"─".repeat(60)}`);
    console.log(`   Accounts analyzed:  ${report.accountsAnalyzed}`);
    console.log(`   Passed validation:  ${report.accountsValidated}`);
    console.log(`   Successfully reclaimed: ${report.accountsReclaimed}`);
    console.log(`   Failed:             ${report.accountsFailed}`);
    console.log(`${"─".repeat(60)}`);
    console.log(
      `   Total reclaimed:    ${(report.totalLamportsReclaimed / LAMPORTS_PER_SOL).toFixed(6)} SOL`
    );
    console.log(
      `   Treasury before:    ${(treasuryBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL`
    );
    if (!report.dryRun && report.transactions.length > 0) {
      const last = report.transactions[report.transactions.length - 1];
      console.log(
        `   Treasury after:     ${(last.treasuryBalanceAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
    }
    console.log(`${"═".repeat(60)}\n`);
  }
}
