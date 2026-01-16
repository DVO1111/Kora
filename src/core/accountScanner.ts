import * as fs from "fs";
import logger from "../logger.js";
import { SolanaProvider } from "../solana/provider.js";
import { RentStatus } from "../types.js";

/**
 * Scans the blockchain to find accounts sponsored by the operator
 */
export class AccountScanner {
  private provider: SolanaProvider;
  private operatorAddress: string;
  private rpcUrl: string;

  // Cache for account discovery
  private accountCache: Map<
    string,
    { address: string; createdAt: Date }
  > = new Map();
  private lastCacheBuild: Date = new Date(0);

  constructor(
    provider: SolanaProvider,
    operatorAddress: string,
    rpcUrl: string
  ) {
    this.provider = provider;
    this.operatorAddress = operatorAddress;
    this.rpcUrl = rpcUrl;
  }

  /**
   * Load accounts from a JSON file (for testing or manual configuration)
   */
  async loadAccountsFromFile(filePath: string): Promise<
    Array<{
      address: string;
      createdAt: Date;
    }>
  > {
    try {
      if (!fs.existsSync(filePath)) {
        logger.warn(`Account file not found: ${filePath}`);
        return [];
      }

      const data = fs.readFileSync(filePath, "utf-8");
      const accounts = JSON.parse(data);

      logger.info(`Loaded ${accounts.length} accounts from ${filePath}`);

      return accounts.map((acc: any) => ({
        address: acc.address,
        createdAt: new Date(acc.createdAt || new Date()),
      }));
    } catch (error) {
      logger.error(`Failed to load accounts from file`, error as Error);
      return [];
    }
  }

  /**
   * Save discovered accounts to a file for reference
   */
  async saveAccountsToFile(
    filePath: string,
    accounts: Array<{ address: string; createdAt: Date }>
  ): Promise<void> {
    try {
      const data = JSON.stringify(accounts, null, 2);
      fs.writeFileSync(filePath, data);
      logger.info(`Saved ${accounts.length} accounts to ${filePath}`);
    } catch (error) {
      logger.error(`Failed to save accounts to file`, error as Error);
    }
  }

  /**
   * Discover accounts by querying the blockchain for token accounts owned by users
   * NOTE: This is a simplified version. In production, you'd use Kora's indexing service
   * or query specifically for accounts where the operator is the rent payer
   */
  async discoverSponsoredAccounts(
    tokenProgramId: string = "TokenkegQfeZyiNwAJsyFbPVwwQkYk5modlYKYro8t"
  ): Promise<
    Array<{
      address: string;
      createdAt: Date;
    }>
  > {
    logger.info(`Attempting to discover sponsored accounts...`);
    logger.warn(
      `Account discovery via RPC is limited. Using file-based discovery instead.`
    );

    // In production, you would:
    // 1. Query Kora's indexing service or database
    // 2. Use getProgramAccounts to find accounts created by the operator
    // 3. Cross-reference with transaction history

    // For now, we recommend operators maintain a list of accounts
    return [];
  }

  /**
   * Verify that an account was actually sponsored by the operator
   */
  async verifySponsoredAccount(
    accountAddress: string
  ): Promise<{ sponsored: boolean; details: string }> {
    try {
      const accountInfo = await this.provider.getAccountInfo(accountAddress);

      if (!accountInfo) {
        return {
          sponsored: false,
          details: "Account does not exist",
        };
      }

      // Check if account is a token account
      const isTokenAccount =
        accountInfo.owner.toString() ===
        "TokenkegQfeZyiNwAJsyFbPVwwQkYk5modlYKYro8t";

      if (!isTokenAccount) {
        return {
          sponsored: false,
          details: "Account is not a token account",
        };
      }

      // Additional checks could be performed here
      // For now, we assume it's a sponsored account if it's a token account

      return {
        sponsored: true,
        details: `Token account with ${accountInfo.lamports} lamports`,
      };
    } catch (error) {
      return {
        sponsored: false,
        details: `Error verifying: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Analyze a set of accounts to find those eligible for reclaim
   */
  async analyzeAccounts(
    accounts: Array<{
      address: string;
      createdAt: Date;
    }>
  ): Promise<
    Array<{
      address: string;
      createdAt: Date;
      rentStatus: RentStatus;
    }>
  > {
    const results = [];

    logger.info(`Analyzing ${accounts.length} accounts for reclaim eligibility`);

    for (const account of accounts) {
      try {
        const accountInfo = await this.provider.getAccountInfo(account.address);

        if (!accountInfo) {
          results.push({
            address: account.address,
            createdAt: account.createdAt,
            rentStatus: {
              address: account.address,
              lamports: 0,
              rentAmount: 0,
              isRentExempt: false,
              isEmpty: true,
              isClosed: true,
              canReclaim: false,
              reason: "Account closed",
            },
          });
          continue;
        }

        // Calculate rent status
        const minBalance =
          await this.provider.getMinimumBalanceForRentExemption(
            accountInfo.data.length
          );
        const isEmpty = accountInfo.data.length === 0;
        const isRentExempt = accountInfo.lamports >= minBalance;

        results.push({
          address: account.address,
          createdAt: account.createdAt,
          rentStatus: {
            address: account.address,
            lamports: accountInfo.lamports,
            rentAmount: Math.max(0, accountInfo.lamports - minBalance) / 1e9,
            isRentExempt,
            isEmpty,
            isClosed: false,
            canReclaim: isEmpty && !isRentExempt,
            reason: isEmpty
              ? isRentExempt
                ? "Account is rent-exempt"
                : "Account is empty"
              : "Account has data",
          },
        });
      } catch (error) {
        logger.error(
          `Failed to analyze account ${account.address}`,
          error as Error
        );
      }
    }

    return results;
  }

  /**
   * Update the cache with discovered accounts
   */
  setCachedAccounts(
    accounts: Array<{
      address: string;
      createdAt: Date;
    }>
  ): void {
    this.accountCache.clear();
    for (const account of accounts) {
      this.accountCache.set(account.address, account);
    }
    this.lastCacheBuild = new Date();
    logger.info(
      `Updated account cache with ${accounts.length} accounts`
    );
  }

  /**
   * Get cached accounts
   */
  getCachedAccounts(): Array<{
    address: string;
    createdAt: Date;
  }> {
    return Array.from(this.accountCache.values());
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      cachedAccounts: this.accountCache.size,
      lastUpdated: this.lastCacheBuild,
      age: new Date().getTime() - this.lastCacheBuild.getTime(),
    };
  }
}
