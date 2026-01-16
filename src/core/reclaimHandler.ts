import { PublicKey } from "@solana/web3.js";
import logger, {
  logReclaimAttempt,
  logReclaimSuccess,
  logReclaimFailure,
} from "../logger.js";
import { SolanaProvider } from "../solana/provider.js";
import { ReclaimResult } from "../types.js";

/**
 * Handles the actual rent reclaim process
 */
export class ReclaimHandler {
  private provider: SolanaProvider;
  private recipientAddress: string;
  private dryRun: boolean;

  constructor(
    provider: SolanaProvider,
    recipientAddress: string,
    dryRun: boolean = false
  ) {
    this.provider = provider;
    this.recipientAddress = recipientAddress;
    this.dryRun = dryRun;
  }

  /**
   * Reclaim rent from a single account
   */
  async reclaimFromAccount(
    accountAddress: string,
    rentAmount: number
  ): Promise<ReclaimResult> {
    try {
      logReclaimAttempt(accountAddress, rentAmount, this.dryRun);

      const accountPubkey = new PublicKey(accountAddress);
      const recipientPubkey = new PublicKey(this.recipientAddress);

      // Attempt to close the account
      const txSignature = await this.provider.closeAccount(
        accountPubkey,
        recipientPubkey,
        this.dryRun
      );

      if (!txSignature) {
        if (this.dryRun) {
          logReclaimSuccess(accountAddress, rentAmount, "[DRY_RUN]", true);
          return {
            address: accountAddress,
            success: true,
            amountReclaimed: rentAmount,
            rentReclaimed: rentAmount,
            timestamp: new Date(),
          };
        } else {
          throw new Error("Failed to get transaction signature");
        }
      }

      logReclaimSuccess(accountAddress, rentAmount, txSignature, this.dryRun);

      return {
        address: accountAddress,
        success: true,
        transactionSignature: txSignature,
        amountReclaimed: rentAmount,
        rentReclaimed: rentAmount,
        timestamp: new Date(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logReclaimFailure(accountAddress, errorMessage, this.dryRun);

      return {
        address: accountAddress,
        success: false,
        error: errorMessage,
        amountReclaimed: 0,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Reclaim from multiple accounts in batch
   */
  async reclaimBatch(
    accounts: Array<{
      address: string;
      rentAmount: number;
    }>
  ): Promise<ReclaimResult[]> {
    const results: ReclaimResult[] = [];
    let totalReclaimed = 0;
    let successCount = 0;

    logger.info(
      `Starting batch reclaim of ${accounts.length} accounts (${this.dryRun ? "DRY_RUN" : "LIVE"})`
    );

    for (const account of accounts) {
      const result = await this.reclaimFromAccount(
        account.address,
        account.rentAmount
      );
      results.push(result);

      if (result.success && result.rentReclaimed) {
        totalReclaimed += result.rentReclaimed;
        successCount++;
      }
    }

    logger.info(
      `Batch reclaim complete: ${successCount}/${accounts.length} successful | ${totalReclaimed} SOL recovered`
    );

    return results;
  }

  /**
   * Get summary of reclaim operations
   */
  generateSummary(results: ReclaimResult[]) {
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const totalReclaimed = successful.reduce(
      (sum, r) => sum + (r.rentReclaimed || 0),
      0
    );

    return {
      totalAttempts: results.length,
      successful: successful.length,
      failed: failed.length,
      successRate: ((successful.length / results.length) * 100).toFixed(2),
      totalReclaimed,
      failedAccounts: failed.map((r) => ({
        address: r.address,
        error: r.error,
      })),
    };
  }

  /**
   * Set dry-run mode
   */
  setDryRun(enabled: boolean): void {
    this.dryRun = enabled;
    logger.info(`Dry-run mode ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Get current configuration
   */
  getConfig() {
    return {
      recipientAddress: this.recipientAddress,
      dryRun: this.dryRun,
      payerAddress: this.provider.getPayerAddress(),
    };
  }
}
