import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import logger from "../logger.js";
import { SponsoredAccountDiscovery } from "./sponsoredAccountDiscovery.js";
import { RentReclaimer } from "./rentReclaimer.js";
import { SponsoredAccount, ReclaimResult, RentStatus } from "../types.js";
import { formatSol } from "../utils/helpers.js";

export interface BotConfig {
  rpcUrl: string;
  operatorAddress: string;
  treasuryAddress: string;
  privateKeyPath?: string;
  privateKey?: number[];
  accountsFile?: string;
  minAccountAge?: number; // Days
  whitelist?: string[];
  blacklist?: string[];
  dryRun?: boolean;
  maxTransactionsPerRun?: number;
}

export interface BotStats {
  accountsDiscovered: number;
  accountsAnalyzed: number;
  reclaimableAccounts: number;
  closedAccounts: number;
  totalRentLocked: number;
  totalReclaimable: number;
  successfulReclaims: number;
  failedReclaims: number;
  totalReclaimed: number;
}

/**
 * Main Kora Rent Reclaim Bot
 * Discovers, analyzes, and reclaims rent from sponsored accounts
 */
export class KoraRentReclaimBot {
  private config: BotConfig;
  private discovery: SponsoredAccountDiscovery;
  private reclaimer: RentReclaimer | null = null;
  private connection: Connection;
  private sponsoredAccounts: SponsoredAccount[] = [];
  private accountStatuses: Map<string, RentStatus> = new Map();
  private stats: BotStats;

  constructor(config: BotConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.discovery = new SponsoredAccountDiscovery(
      config.rpcUrl,
      config.operatorAddress
    );

    // Initialize reclaimer if private key is available
    if (config.privateKeyPath || config.privateKey) {
      const keypair = this.loadKeypair();
      if (keypair) {
        this.reclaimer = new RentReclaimer(
          config.rpcUrl,
          config.treasuryAddress,
          keypair
        );
      }
    }

    this.stats = this.initStats();
  }

  private initStats(): BotStats {
    return {
      accountsDiscovered: 0,
      accountsAnalyzed: 0,
      reclaimableAccounts: 0,
      closedAccounts: 0,
      totalRentLocked: 0,
      totalReclaimable: 0,
      successfulReclaims: 0,
      failedReclaims: 0,
      totalReclaimed: 0,
    };
  }

  private loadKeypair(): Keypair | null {
    try {
      if (this.config.privateKey) {
        return Keypair.fromSecretKey(Uint8Array.from(this.config.privateKey));
      }

      if (this.config.privateKeyPath) {
        const keyPath = path.resolve(this.config.privateKeyPath);
        if (!fs.existsSync(keyPath)) {
          logger.error(`Private key file not found: ${keyPath}`);
          return null;
        }

        const keyData = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
        return Keypair.fromSecretKey(Uint8Array.from(keyData));
      }

      return null;
    } catch (error) {
      logger.error("Failed to load keypair", error as Error);
      return null;
    }
  }

  /**
   * Step 1: Discover sponsored accounts
   */
  async discoverAccounts(transactionLimit: number = 1000): Promise<void> {
    logger.info("=== Step 1: Discovering Sponsored Accounts ===");

    // First, try to load from file if specified
    if (this.config.accountsFile) {
      const loaded = await this.loadAccountsFromFile(this.config.accountsFile);
      this.sponsoredAccounts.push(...loaded);
    }

    // Then discover from blockchain
    const discovered = await this.discovery.discoverSponsoredAccounts(
      transactionLimit
    );

    // Merge and deduplicate
    const existingAddresses = new Set(
      this.sponsoredAccounts.map((a) => a.address)
    );
    for (const account of discovered) {
      if (!existingAddresses.has(account.address)) {
        this.sponsoredAccounts.push(account);
      }
    }

    this.stats.accountsDiscovered = this.sponsoredAccounts.length;
    logger.info(
      `Discovered ${this.sponsoredAccounts.length} total sponsored accounts`
    );
  }

  /**
   * Load accounts from a JSON file
   */
  private async loadAccountsFromFile(
    filePath: string
  ): Promise<SponsoredAccount[]> {
    try {
      const fullPath = path.resolve(filePath);
      if (!fs.existsSync(fullPath)) {
        logger.warn(`Accounts file not found: ${fullPath}`);
        return [];
      }

      const data = JSON.parse(fs.readFileSync(fullPath, "utf-8"));

      // Handle different file formats
      if (Array.isArray(data)) {
        if (typeof data[0] === "string") {
          // Array of addresses
          return data.map((address: string) => ({
            address,
            owner: "",
            lamports: 0,
            dataSize: 0,
            executable: false,
            createdAt: new Date(),
          }));
        } else {
          // Array of account objects
          return data;
        }
      } else if (data.accounts) {
        return data.accounts;
      }

      return [];
    } catch (error) {
      logger.error(`Failed to load accounts from file: ${filePath}`, error as Error);
      return [];
    }
  }

  /**
   * Step 2: Analyze account statuses
   */
  async analyzeAccounts(): Promise<void> {
    logger.info("=== Step 2: Analyzing Account Statuses ===");

    // Apply filters
    let filtered = this.sponsoredAccounts;

    // Whitelist filter
    if (this.config.whitelist && this.config.whitelist.length > 0) {
      const whitelistSet = new Set(this.config.whitelist);
      filtered = filtered.filter((a) => whitelistSet.has(a.address));
      logger.info(`After whitelist: ${filtered.length} accounts`);
    }

    // Blacklist filter
    if (this.config.blacklist && this.config.blacklist.length > 0) {
      const blacklistSet = new Set(this.config.blacklist);
      filtered = filtered.filter((a) => !blacklistSet.has(a.address));
      logger.info(`After blacklist: ${filtered.length} accounts`);
    }

    // Age filter
    if (this.config.minAccountAge && this.config.minAccountAge > 0) {
      const minAge = this.config.minAccountAge * 24 * 60 * 60 * 1000; // Convert days to ms
      const now = Date.now();
      filtered = filtered.filter((a) => {
        const age = now - new Date(a.createdAt).getTime();
        return age >= minAge;
      });
      logger.info(
        `After age filter (${this.config.minAccountAge} days): ${filtered.length} accounts`
      );
    }

    // Get status for filtered accounts
    this.accountStatuses = await this.discovery.getAccountStatuses(filtered);

    // Update stats
    this.stats.accountsAnalyzed = this.accountStatuses.size;
    for (const status of this.accountStatuses.values()) {
      if (status.isClosed) {
        this.stats.closedAccounts++;
      } else {
        this.stats.totalRentLocked += status.rentAmount;
        if (status.canReclaim) {
          this.stats.reclaimableAccounts++;
          this.stats.totalReclaimable += status.rentAmount;
        }
      }
    }

    logger.info(`Analyzed ${this.stats.accountsAnalyzed} accounts:`);
    logger.info(`  - Closed: ${this.stats.closedAccounts}`);
    logger.info(`  - Reclaimable: ${this.stats.reclaimableAccounts}`);
    logger.info(`  - Total rent locked: ${formatSol(this.stats.totalRentLocked)}`);
    logger.info(`  - Total reclaimable: ${formatSol(this.stats.totalReclaimable)}`);
  }

  /**
   * Step 3: Execute reclaims
   */
  async executeReclaims(): Promise<ReclaimResult[]> {
    logger.info("=== Step 3: Executing Reclaims ===");

    if (!this.reclaimer) {
      logger.error("No reclaimer available - private key not loaded");
      return [];
    }

    if (this.stats.reclaimableAccounts === 0) {
      logger.info("No reclaimable accounts found");
      return [];
    }

    const dryRun = this.config.dryRun !== false; // Default to dry run
    const maxTx = this.config.maxTransactionsPerRun || 10;

    // Get reclaimable accounts
    const reclaimable: RentStatus[] = [];
    for (const status of this.accountStatuses.values()) {
      if (status.canReclaim && reclaimable.length < maxTx) {
        reclaimable.push(status);
      }
    }

    logger.info(
      `Attempting to reclaim from ${reclaimable.length} accounts (dryRun=${dryRun})`
    );

    const results = await this.reclaimer.batchReclaim(reclaimable, dryRun);

    // Update stats
    for (const result of results) {
      if (result.success) {
        this.stats.successfulReclaims++;
        this.stats.totalReclaimed += result.amountReclaimed;
      } else {
        this.stats.failedReclaims++;
      }
    }

    return results;
  }

  /**
   * Run the complete bot cycle
   */
  async run(options?: {
    transactionLimit?: number;
    skipReclaim?: boolean;
  }): Promise<BotStats> {
    const transactionLimit = options?.transactionLimit || 1000;
    const skipReclaim = options?.skipReclaim || false;

    logger.info("========================================");
    logger.info("    Kora Rent Reclaim Bot - Starting    ");
    logger.info("========================================");
    logger.info(`Operator: ${this.config.operatorAddress}`);
    logger.info(`Treasury: ${this.config.treasuryAddress}`);
    logger.info(`RPC: ${this.config.rpcUrl}`);
    logger.info(`Dry Run: ${this.config.dryRun !== false}`);
    logger.info("========================================");

    // Reset stats
    this.stats = this.initStats();

    // Step 1: Discover
    await this.discoverAccounts(transactionLimit);

    // Step 2: Analyze
    await this.analyzeAccounts();

    // Step 3: Reclaim (if not skipped)
    if (!skipReclaim && this.stats.reclaimableAccounts > 0) {
      await this.executeReclaims();
    }

    // Print summary
    this.printSummary();

    return this.stats;
  }

  /**
   * Check mode - analyze only, no reclaim
   */
  async check(transactionLimit: number = 1000): Promise<BotStats> {
    return this.run({ transactionLimit, skipReclaim: true });
  }

  /**
   * Reclaim mode - analyze and execute reclaims
   */
  async reclaim(transactionLimit: number = 1000): Promise<BotStats> {
    return this.run({ transactionLimit, skipReclaim: false });
  }

  /**
   * Print summary of the run
   */
  private printSummary(): void {
    logger.info("");
    logger.info("========================================");
    logger.info("           RUN SUMMARY                  ");
    logger.info("========================================");
    logger.info(`Accounts Discovered:    ${this.stats.accountsDiscovered}`);
    logger.info(`Accounts Analyzed:      ${this.stats.accountsAnalyzed}`);
    logger.info(`Closed Accounts:        ${this.stats.closedAccounts}`);
    logger.info(`Reclaimable Accounts:   ${this.stats.reclaimableAccounts}`);
    logger.info(`Total Rent Locked:      ${formatSol(this.stats.totalRentLocked)}`);
    logger.info(`Total Reclaimable:      ${formatSol(this.stats.totalReclaimable)}`);
    logger.info("----------------------------------------");
    logger.info(`Successful Reclaims:    ${this.stats.successfulReclaims}`);
    logger.info(`Failed Reclaims:        ${this.stats.failedReclaims}`);
    logger.info(`Total Reclaimed:        ${formatSol(this.stats.totalReclaimed)}`);
    logger.info("========================================");
  }

  /**
   * Get current balance of treasury
   */
  async getTreasuryBalance(): Promise<number> {
    const balance = await this.connection.getBalance(
      new PublicKey(this.config.treasuryAddress)
    );
    return balance / LAMPORTS_PER_SOL;
  }

  /**
   * Get operator balance
   */
  async getOperatorBalance(): Promise<number> {
    const balance = await this.connection.getBalance(
      new PublicKey(this.config.operatorAddress)
    );
    return balance / LAMPORTS_PER_SOL;
  }

  /**
   * Export accounts to file
   */
  async exportAccounts(filePath: string): Promise<void> {
    const data = {
      timestamp: new Date().toISOString(),
      operator: this.config.operatorAddress,
      accounts: Array.from(this.accountStatuses.entries()).map(
        ([addr, status]) => ({
          ...status,
          exportedAddress: addr,
        })
      ),
      stats: this.stats,
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    logger.info(`Exported ${this.accountStatuses.size} accounts to ${filePath}`);
  }

  /**
   * Get detailed status of a specific account
   */
  async getAccountDetail(address: string): Promise<{
    address: string;
    exists: boolean;
    balance: number;
    owner: string;
    dataLength: number;
    isRentExempt: boolean;
    canReclaim: boolean;
    reason: string;
  }> {
    const pubkey = new PublicKey(address);
    const accountInfo = await this.connection.getAccountInfo(pubkey);

    if (!accountInfo) {
      return {
        address,
        exists: false,
        balance: 0,
        owner: "",
        dataLength: 0,
        isRentExempt: false,
        canReclaim: false,
        reason: "Account does not exist",
      };
    }

    const minBalance = await this.connection.getMinimumBalanceForRentExemption(
      accountInfo.data.length
    );

    const isRentExempt = accountInfo.lamports >= minBalance;
    const isEmpty =
      accountInfo.data.length === 0 ||
      accountInfo.data.every((byte) => byte === 0);

    return {
      address,
      exists: true,
      balance: accountInfo.lamports / LAMPORTS_PER_SOL,
      owner: accountInfo.owner.toString(),
      dataLength: accountInfo.data.length,
      isRentExempt,
      canReclaim: isEmpty,
      reason: isEmpty
        ? "Account is empty and can be closed"
        : "Account has data and cannot be closed",
    };
  }
}
