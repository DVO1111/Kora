import { PublicKey } from "@solana/web3.js";
import logger from "../logger.js";
import { RentStatus } from "../types.js";

/**
 * Validates whether an account is safe to reclaim based on configured policies
 */
export class SafetyValidator {
  private whitelistMode: boolean;
  private whitelist: Set<string>;
  private blacklist: Set<string>;
  private minAccountAge: number; // in days
  private maxReclaimPerBatch: number;

  constructor(
    whitelistMode: boolean = false,
    whitelist: string[] = [],
    blacklist: string[] = [],
    minAccountAge: number = 30,
    maxReclaimPerBatch: number = 10
  ) {
    this.whitelistMode = whitelistMode;
    this.whitelist = new Set(whitelist);
    this.blacklist = new Set(blacklist);
    this.minAccountAge = minAccountAge;
    this.maxReclaimPerBatch = maxReclaimPerBatch;
  }

  /**
   * Validate if an account is safe to reclaim
   */
  validateForReclaim(
    address: string,
    rentStatus: RentStatus,
    createdAt: Date
  ): { safe: boolean; reason: string } {
    // Check if in blacklist
    if (this.blacklist.has(address)) {
      return {
        safe: false,
        reason: "Account is in blacklist",
      };
    }

    // Check whitelist mode
    if (this.whitelistMode && !this.whitelist.has(address)) {
      return {
        safe: false,
        reason: "Whitelist mode enabled and account not in whitelist",
      };
    }

    // Check if account is eligible for reclaim
    if (!rentStatus.canReclaim) {
      return {
        safe: false,
        reason: rentStatus.reason,
      };
    }

    // Check minimum age
    const now = new Date();
    const ageInDays =
      (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (ageInDays < this.minAccountAge) {
      return {
        safe: false,
        reason: `Account age (${ageInDays.toFixed(1)} days) is less than minimum (${this.minAccountAge} days)`,
      };
    }

    // Check if address is valid Solana address
    try {
      new PublicKey(address);
    } catch {
      return {
        safe: false,
        reason: "Invalid Solana address",
      };
    }

    return {
      safe: true,
      reason: "All checks passed",
    };
  }

  /**
   * Validate multiple accounts and return batch
   */
  validateBatch(
    accounts: Array<{
      address: string;
      rentStatus: RentStatus;
      createdAt: Date;
    }>
  ): {
    approved: typeof accounts;
    rejected: Array<{
      account: typeof accounts[0];
      reason: string;
    }>;
  } {
    const approved = [];
    const rejected = [];

    for (const account of accounts) {
      const validation = this.validateForReclaim(
        account.address,
        account.rentStatus,
        account.createdAt
      );

      if (validation.safe) {
        approved.push(account);
        if (approved.length >= this.maxReclaimPerBatch) {
          break;
        }
      } else {
        rejected.push({
          account,
          reason: validation.reason,
        });
      }
    }

    return { approved, rejected };
  }

  /**
   * Update whitelist
   */
  addToWhitelist(addresses: string[]): void {
    addresses.forEach((addr) => this.whitelist.add(addr));
    logger.info(`Added ${addresses.length} addresses to whitelist`);
  }

  /**
   * Update blacklist
   */
  addToBlacklist(addresses: string[]): void {
    addresses.forEach((addr) => this.blacklist.add(addr));
    logger.info(`Added ${addresses.length} addresses to blacklist`);
  }

  /**
   * Remove from whitelist
   */
  removeFromWhitelist(addresses: string[]): void {
    addresses.forEach((addr) => this.whitelist.delete(addr));
    logger.info(`Removed ${addresses.length} addresses from whitelist`);
  }

  /**
   * Remove from blacklist
   */
  removeFromBlacklist(addresses: string[]): void {
    addresses.forEach((addr) => this.blacklist.delete(addr));
    logger.info(`Removed ${addresses.length} addresses from blacklist`);
  }

  /**
   * Get current configuration
   */
  getConfig() {
    return {
      whitelistMode: this.whitelistMode,
      whitelist: Array.from(this.whitelist),
      blacklist: Array.from(this.blacklist),
      minAccountAge: this.minAccountAge,
      maxReclaimPerBatch: this.maxReclaimPerBatch,
    };
  }
}
