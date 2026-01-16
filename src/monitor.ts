import * as fs from "fs";
import cron from "node-cron";
import { Keypair } from "@solana/web3.js";
import { Config } from "./config.js";
import logger, { logSessionStart, logSessionEnd } from "./logger.js";
import { SolanaProvider } from "./solana/provider.js";
import { RentCalculator } from "./core/rentCalculator.js";
import { SafetyValidator } from "./core/validator.js";
import { ReclaimHandler } from "./core/reclaimHandler.js";
import { AccountScanner } from "./core/accountScanner.js";
import { TelegramAlerts } from "./alerts/reporter.js";

/**
 * Load keypair from file
 */
function loadKeypair(path: string): Keypair {
  const keypairData = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(keypairData));
}

/**
 * Main monitoring loop
 */
async function runMonitoringSession() {
  const startTime = new Date();

  try {
    const configInstance = new Config();
    configInstance.validate();
    const config = Config.loadFromEnv();

    const keypair = loadKeypair(
      process.env.OPERATOR_KEYPAIR_PATH || "./keys/operator-keypair.json"
    );
    const provider = new SolanaProvider(config.rpcUrl, keypair);
    const scanner = new AccountScanner(
      provider,
      keypair.publicKey.toString(),
      config.rpcUrl
    );
    const rentCalculator = new RentCalculator(
      provider,
      config.reclaimPolicy.minRentToReclaim
    );
    const validator = new SafetyValidator(
      config.safety.whitelistMode,
      config.safety.whitelist,
      config.safety.blacklist,
      config.safety.minAccountAge,
      config.reclaimPolicy.maxReclaimPerBatch
    );
    const telegramAlerts = new TelegramAlerts();

    // Load accounts
    let accounts = await scanner.loadAccountsFromFile("./accounts.json");

    if (accounts.length === 0) {
      logger.warn("No accounts loaded. Please create accounts.json");
      return;
    }

    logSessionStart(config.operatorName, accounts.length);

    // Analyze accounts
    const analyzed = await scanner.analyzeAccounts(accounts);
    const summary = rentCalculator.summarizeRentStatus(
      analyzed.map((a) => a.rentStatus)
    );

    logger.info(`
=== Rent Analysis ===
Total Rent Locked: ${summary.totalRent.toFixed(4)} SOL
Accounts with Rent: ${summary.accountsWithRent}
Reclaimable: ${summary.totalReclaimable.toFixed(4)} SOL
Eligible Accounts: ${summary.accountsReclaimable}
    `);

    // Check for large idle rent and alert
    if (
      config.alerts.enabled &&
      summary.totalRent > config.alerts.thresholds.largeIdleRent
    ) {
      await telegramAlerts.alertLargeIdleRent(
        summary.totalRent,
        summary.accountsWithRent
      );
    }

    // Get eligible accounts
    const reclaimCandidates = analyzed
      .filter((a) => a.rentStatus.canReclaim)
      .map((a) => ({
        address: a.address,
        rentStatus: a.rentStatus,
        createdAt: a.createdAt,
      }));

    let totalReclaimed = 0;
    let successCount = 0;

    if (reclaimCandidates.length > 0 && config.reclaimPolicy.autoReclaim) {
      // Validate batch
      const { approved } = validator.validateBatch(
        reclaimCandidates as any
      );

      if (approved.length > 0) {
        logger.info(
          `Auto-reclaiming from ${approved.length} eligible accounts...`
        );

        // Execute reclaim
        const handler = new ReclaimHandler(
          provider,
          config.treasuryAddress,
          config.safety.dryRun
        );

        const results = await handler.reclaimBatch(
          approved.map((a) => ({
            address: (a as any).address,
            rentAmount: (a as any).rentStatus.rentAmount,
          }))
        );

        const reclaimSummary = handler.generateSummary(results);
        successCount = reclaimSummary.successful;
        totalReclaimed = reclaimSummary.totalReclaimed;

        logger.info(`
=== Reclaim Summary ===
Successful: ${reclaimSummary.successful}/${reclaimSummary.totalAttempts}
Total Reclaimed: ${reclaimSummary.totalReclaimed.toFixed(4)} SOL
        `);

        // Alert on success
        if (
          config.alerts.enabled &&
          config.alerts.thresholds.reclaimSuccess &&
          successCount > 0
        ) {
          const firstResult = results.find((r) => r.success);
          await telegramAlerts.alertReclaimSuccess(
            successCount,
            totalReclaimed,
            firstResult?.transactionSignature
          );
        }
      }
    }

    const endTime = new Date();
    logSessionEnd(accounts.length, successCount, totalReclaimed);

    logger.info(
      `Monitoring session complete in ${((endTime.getTime() - startTime.getTime()) / 1000).toFixed(2)}s`
    );
  } catch (error) {
    logger.error(
      "Monitoring session error",
      error instanceof Error ? error : new Error(String(error))
    );

    // Alert on failure
    const telegramAlerts = new TelegramAlerts();
    if (telegramAlerts.isEnabled()) {
      await telegramAlerts.alertReclaimFailure(
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
}

/**
 * Start monitoring service
 */
function startMonitoringService() {
  try {
    const config = Config.loadFromEnv();

    if (!config.monitoring.enabled) {
      logger.warn("Monitoring is disabled in config");
      return;
    }

    const intervalMinutes = config.monitoring.intervalMinutes;
    const cronExpression = `*/${intervalMinutes} * * * *`; // Run every N minutes

    logger.info(
      `Starting monitoring service (interval: ${intervalMinutes} minutes)`
    );
    logger.info(`Cron expression: ${cronExpression}`);

    // Run immediately first
    runMonitoringSession().catch((error) => {
      logger.error("Initial monitoring run failed", error as Error);
    });

    // Schedule recurring runs
    cron.schedule(cronExpression, () => {
      logger.info("Starting scheduled monitoring session...");
      runMonitoringSession().catch((error) => {
        logger.error("Scheduled monitoring run failed", error as Error);
      });
    });

    logger.info("Monitoring service started. Press Ctrl+C to stop.");
  } catch (error) {
    logger.error(
      "Failed to start monitoring service",
      error instanceof Error ? error : new Error(String(error))
    );
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  logger.info("Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

// Start the service
startMonitoringService();
