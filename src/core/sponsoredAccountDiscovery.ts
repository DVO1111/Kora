import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import logger from "../logger.js";
import { SponsoredAccount, RentStatus } from "../types.js";
import { sleep } from "../utils/helpers.js";
import { PROGRAMS } from "../utils/constants.js";

/**
 * Discovers accounts that were sponsored (rent paid) by the operator
 * by analyzing transaction history
 */
export class SponsoredAccountDiscovery {
  private connection: Connection;
  private operatorAddress: PublicKey;

  constructor(rpcUrl: string, operatorAddress: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.operatorAddress = new PublicKey(operatorAddress);
  }

  /**
   * Discover accounts where the operator paid for account creation (rent)
   * by scanning transaction history
   */
  async discoverSponsoredAccounts(
    limit: number = 1000,
    beforeSignature?: string
  ): Promise<SponsoredAccount[]> {
    const sponsoredAccounts: SponsoredAccount[] = [];

    try {
      logger.info(
        `Discovering sponsored accounts for operator: ${this.operatorAddress.toString()}`
      );

      // Get transaction signatures for the operator
      const signatures = await this.connection.getSignaturesForAddress(
        this.operatorAddress,
        {
          limit,
          before: beforeSignature,
        }
      );

      logger.info(`Found ${signatures.length} transactions to analyze`);

      // Process transactions in smaller batches to avoid rate limiting
      const batchSize = 3; // Smaller batch for public RPC
      for (let i = 0; i < signatures.length; i += batchSize) {
        const batch = signatures.slice(i, i + batchSize);
        const txSignatures = batch.map((s) => s.signature);

        try {
          // Fetch parsed transactions with retry logic
          const transactions = await this.fetchWithRetry(txSignatures);

          for (let j = 0; j < transactions.length; j++) {
            const tx = transactions[j];
            const sig = batch[j];

            if (!tx || tx.meta?.err) continue;

            // Look for account creation instructions
            const createdAccounts = this.extractCreatedAccounts(tx, sig.blockTime);
            sponsoredAccounts.push(...createdAccounts);
          }
        } catch (error) {
          logger.warn(`Batch failed at offset ${i}, continuing...`);
        }

        // More aggressive rate limiting for public RPC
        if (i + batchSize < signatures.length) {
          await sleep(500);
        }
      }

      logger.info(
        `Discovered ${sponsoredAccounts.length} potentially sponsored accounts`
      );
      return sponsoredAccounts;
    } catch (error) {
      logger.error("Failed to discover sponsored accounts", error as Error);
      return [];
    }
  }

  /**
   * Fetch transactions with retry logic for rate limiting
   */
  private async fetchWithRetry(
    signatures: string[],
    maxRetries: number = 3
  ): Promise<(ParsedTransactionWithMeta | null)[]> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.connection.getParsedTransactions(signatures, {
          maxSupportedTransactionVersion: 0,
        });
      } catch (error) {
        if (attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          logger.warn(`Rate limited, retrying in ${delay}ms...`);
          await sleep(delay);
        } else {
          throw error;
        }
      }
    }
    return [];
  }

  /**
   * Extract accounts that were created in a transaction where operator was fee payer
   */
  private extractCreatedAccounts(
    tx: ParsedTransactionWithMeta,
    blockTime: number | null | undefined
  ): SponsoredAccount[] {
    const accounts: SponsoredAccount[] = [];
    const feePayer = tx.transaction.message.accountKeys[0]?.pubkey;

    // Only consider transactions where our operator was the fee payer
    if (!feePayer || feePayer.toString() !== this.operatorAddress.toString()) {
      return [];
    }

    // Look through instructions for account creation
    for (const instruction of tx.transaction.message.instructions) {
      if ("parsed" in instruction) {
        const parsed = instruction.parsed;

        // System Program: CreateAccount
        if (
          instruction.program === "system" &&
          parsed?.type === "createAccount"
        ) {
          const info = parsed.info;
          accounts.push({
            address: info.newAccount,
            owner: info.owner || PROGRAMS.SYSTEM,
            lamports: info.lamports,
            dataSize: info.space || 0,
            executable: false,
            createdAt: blockTime ? new Date(blockTime * 1000) : new Date(),
          });
        }

        // SPL Token: InitializeAccount (associated token account creation)
        if (
          instruction.program === "spl-associated-token-account" &&
          parsed?.type === "create"
        ) {
          const info = parsed.info;
          accounts.push({
            address: info.account,
            owner: PROGRAMS.TOKEN,
            lamports: 0, // Will be filled later
            dataSize: 165, // Token account size
            executable: false,
            createdAt: blockTime ? new Date(blockTime * 1000) : new Date(),
          });
        }
      }
    }

    return accounts;
  }

  /**
   * Get current status of sponsored accounts
   */
  async getAccountStatuses(
    accounts: SponsoredAccount[]
  ): Promise<Map<string, RentStatus>> {
    const statuses = new Map<string, RentStatus>();

    // Batch fetch account info
    const batchSize = 100;
    for (let i = 0; i < accounts.length; i += batchSize) {
      const batch = accounts.slice(i, i + batchSize);
      const pubkeys = batch.map((a) => new PublicKey(a.address));

      const accountInfos =
        await this.connection.getMultipleAccountsInfo(pubkeys);

      for (let j = 0; j < accountInfos.length; j++) {
        const account = batch[j];
        const info = accountInfos[j];

        if (!info) {
          // Account no longer exists - closed
          statuses.set(account.address, {
            address: account.address,
            lamports: 0,
            rentAmount: 0,
            isRentExempt: false,
            isEmpty: true,
            isClosed: true,
            canReclaim: false,
            reason: "Account closed - rent already reclaimed",
          });
          continue;
        }

        // Calculate rent status
        const minBalance =
          await this.connection.getMinimumBalanceForRentExemption(
            info.data.length
          );
        const isEmpty = info.data.length === 0 || this.isEmptyData(info.data);
        const isRentExempt = info.lamports >= minBalance;
        const rentAmount = info.lamports / LAMPORTS_PER_SOL;

        // Determine if we can reclaim
        let canReclaim = false;
        let reason = "";

        if (info.data.length === 0) {
          canReclaim = true;
          reason = "Empty system account - can close and reclaim rent";
        } else if (isEmpty && info.owner.toString() === PROGRAMS.TOKEN) {
          canReclaim = true;
          reason = "Empty token account - can close and reclaim rent";
        } else {
          canReclaim = false;
          reason = "Account has data - cannot close";
        }

        statuses.set(account.address, {
          address: account.address,
          lamports: info.lamports,
          rentAmount,
          isRentExempt,
          isEmpty,
          isClosed: false,
          canReclaim,
          reason,
        });
      }

      // Rate limiting
      if (i + batchSize < accounts.length) {
        await sleep(100);
      }
    }

    return statuses;
  }

  /**
   * Check if account data is effectively empty (all zeros or initialized but unused)
   */
  private isEmptyData(data: Buffer): boolean {
    // For token accounts, check if balance is zero
    if (data.length === 165) {
      // Token account structure: first 64 bytes are mint/owner, bytes 64-72 are amount
      const amount = data.readBigUInt64LE(64);
      return amount === 0n;
    }

    // For other accounts, check if all zeros
    return data.every((byte) => byte === 0);
  }

  /**
   * Get summary statistics
   */
  async getSummaryStats(
    accounts: SponsoredAccount[]
  ): Promise<{
    totalAccounts: number;
    closedAccounts: number;
    activeAccounts: number;
    reclaimableAccounts: number;
    totalRentLocked: number;
    totalReclaimable: number;
  }> {
    const statuses = await this.getAccountStatuses(accounts);

    let closedAccounts = 0;
    let activeAccounts = 0;
    let reclaimableAccounts = 0;
    let totalRentLocked = 0;
    let totalReclaimable = 0;

    for (const status of statuses.values()) {
      if (status.isClosed) {
        closedAccounts++;
      } else {
        activeAccounts++;
        totalRentLocked += status.rentAmount;

        if (status.canReclaim) {
          reclaimableAccounts++;
          totalReclaimable += status.rentAmount;
        }
      }
    }

    return {
      totalAccounts: accounts.length,
      closedAccounts,
      activeAccounts,
      reclaimableAccounts,
      totalRentLocked,
      totalReclaimable,
    };
  }
}
