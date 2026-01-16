import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import logger from "../logger.js";
import { SolanaProvider } from "../solana/provider.js";
import { RentStatus } from "../types.js";

/**
 * Calculate if an account is eligible for rent reclaim
 */
export class RentCalculator {
  private provider: SolanaProvider;
  private minRentToReclaim: number; // in SOL

  constructor(provider: SolanaProvider, minRentToReclaim: number = 0.002) {
    this.provider = provider;
    this.minRentToReclaim = minRentToReclaim;
  }

  /**
   * Analyze an account's rent status
   */
  async analyzeRentStatus(address: string): Promise<RentStatus> {
    const pubkey = new PublicKey(address);
    const accountInfo = await this.provider.getAccountInfo(address);

    const status: RentStatus = {
      address,
      lamports: 0,
      rentAmount: 0,
      isRentExempt: false,
      isEmpty: false,
      isClosed: false,
      canReclaim: false,
      reason: "Unknown",
    };

    if (!accountInfo) {
      status.isClosed = true;
      status.reason = "Account does not exist on-chain";
      return status;
    }

    status.lamports = accountInfo.lamports;
    status.isEmpty = accountInfo.data.length === 0;

    // Calculate rent amount
    const minBalanceForRentExemption =
      await this.provider.getMinimumBalanceForRentExemption(
        accountInfo.data.length
      );
    status.isRentExempt = accountInfo.lamports >= minBalanceForRentExemption;
    status.rentAmount =
      Math.max(0, accountInfo.lamports - minBalanceForRentExemption) /
      LAMPORTS_PER_SOL;

    // Determine if account can be reclaimed
    if (status.isEmpty && !status.isRentExempt) {
      status.canReclaim = status.rentAmount >= this.minRentToReclaim;
      status.reason = status.canReclaim
        ? `Account is empty and has ${status.rentAmount} SOL rent (> ${this.minRentToReclaim})`
        : `Account is empty but rent (${status.rentAmount} SOL) is below threshold (${this.minRentToReclaim})`;
    } else if (status.isEmpty && status.isRentExempt) {
      status.canReclaim = false;
      status.reason = "Account is rent-exempt, no rent to reclaim";
    } else {
      status.canReclaim = false;
      status.reason = "Account has data, cannot be closed";
    }

    return status;
  }

  /**
   * Estimate rent for a given data size
   */
  async estimateRentForDataSize(dataSize: number): Promise<number> {
    try {
      const minBalance =
        await this.provider.getMinimumBalanceForRentExemption(dataSize);
      return minBalance / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.error("Failed to estimate rent", error as Error);
      return 0;
    }
  }

  /**
   * Check if account has been inactive for a certain period
   * (Note: This requires tracking account modifications, which we'll do via logs)
   */
  isAccountOldEnough(createdAt: Date, minDays: number): boolean {
    const now = new Date();
    const ageInDays =
      (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    return ageInDays >= minDays;
  }

  /**
   * Batch analyze multiple accounts
   */
  async analyzeMultipleAccounts(addresses: string[]): Promise<RentStatus[]> {
    const statuses: RentStatus[] = [];

    for (const address of addresses) {
      const status = await this.analyzeRentStatus(address);
      statuses.push(status);
    }

    return statuses;
  }

  /**
   * Get summary of rent analysis
   */
  summarizeRentStatus(statuses: RentStatus[]): {
    totalRent: number;
    totalReclaimable: number;
    accountsWithRent: number;
    accountsReclaimable: number;
  } {
    let totalRent = 0;
    let totalReclaimable = 0;
    let accountsWithRent = 0;
    let accountsReclaimable = 0;

    for (const status of statuses) {
      if (status.rentAmount > 0) {
        totalRent += status.rentAmount;
        accountsWithRent++;
      }
      if (status.canReclaim) {
        totalReclaimable += status.rentAmount;
        accountsReclaimable++;
      }
    }

    return {
      totalRent,
      totalReclaimable,
      accountsWithRent,
      accountsReclaimable,
    };
  }
}
