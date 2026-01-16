import * as fs from "fs";
import * as path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Config } from "./config.js";
import logger, {
  logSessionStart,
  logAccountStatus,
  logSessionEnd,
  logError,
} from "./logger.js";
import { SolanaProvider } from "./solana/provider.js";
import { RentCalculator } from "./core/rentCalculator.js";
import { SafetyValidator } from "./core/validator.js";
import { ReclaimHandler } from "./core/reclaimHandler.js";
import { AccountScanner } from "./core/accountScanner.js";
import { SessionReporter } from "./alerts/reporter.js";
import { ReclaimResult } from "./types.js";

/**
 * Load keypair from file
 */
function loadKeypair(path: string): Keypair {
  const keypairData = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(keypairData));
}

/**
 * Main CLI entry point
 */
async function main() {
  try {
    const configInstance = new Config();
    configInstance.validate();
    const config = Config.loadFromEnv();

    const parser = yargs(hideBin(process.argv))
      .command(
        "check",
        "Check account rent status",
        (yargs: yargs.Argv) =>
          yargs
            .option("accounts", {
              description: "Specific accounts to check (space-separated)",
              type: "array",
              alias: "a",
            })
            .option("file", {
              description: "Load accounts from JSON file",
              type: "string",
              alias: "f",
            }),
        handleCheckCommand
      )
      .command(
        "reclaim",
        "Reclaim rent from eligible accounts",
        (yargs: yargs.Argv) =>
          yargs
            .option("accounts", {
              description: "Specific accounts to reclaim (space-separated)",
              type: "array",
              alias: "a",
            })
            .option("file", {
              description: "Load accounts from JSON file",
              type: "string",
              alias: "f",
            })
            .option("dry-run", {
              description: "Preview without executing",
              type: "boolean",
              default: config.safety.dryRun,
            })
            .option("approve", {
              description: "Skip approval prompt",
              type: "boolean",
              alias: "y",
            }),
        handleReclaimCommand
      )
      .command(
        "report",
        "Generate report",
        (yargs: yargs.Argv) =>
          yargs
            .option("from-date", {
              description: "Report start date (ISO format)",
              type: "string",
            })
            .option("to-date", {
              description: "Report end date (ISO format)",
              type: "string",
            })
            .option("format", {
              description: "Report format (json|csv|html)",
              type: "string",
              default: "json",
            }),
        handleReportCommand
      )
      .command(
        "config",
        "Show current configuration",
        () => {},
        handleConfigCommand
      )
      .command(
        "balance",
        "Check operator balance",
        () => {},
        handleBalanceCommand
      )
      .help()
      .alias("help", "h")
      .version();

    await parser.parseAsync();
  } catch (error) {
    logError("Fatal error", error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
  }
}

/**
 * Handle 'check' command
 */
async function handleCheckCommand(argv: any) {
  try {
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

    // Load accounts
    let accounts = [];
    if (argv.file) {
      accounts = await scanner.loadAccountsFromFile(argv.file);
    } else if (argv.accounts && Array.isArray(argv.accounts)) {
      accounts = argv.accounts.map((addr: string) => ({
        address: addr,
        createdAt: new Date(),
      }));
    } else {
      accounts = await scanner.loadAccountsFromFile("./accounts.json");
    }

    if (accounts.length === 0) {
      logger.warn("No accounts to check");
      return;
    }

    logSessionStart(config.operatorName, accounts.length);

    const analyzed = await scanner.analyzeAccounts(accounts);
    const summary = new RentCalculator(
      provider,
      config.reclaimPolicy.minRentToReclaim
    ).summarizeRentStatus(analyzed.map((a) => a.rentStatus));

    // Display results
    for (const account of analyzed) {
      const status = account.rentStatus;
      const statusStr = status.canReclaim ? "ELIGIBLE" : "INELIGIBLE";
      logAccountStatus(
        account.address,
        statusStr,
        status.rentAmount
      );
    }

    logger.info(`
=== Summary ===
Total Accounts: ${analyzed.length}
Total Rent Locked: ${summary.totalRent.toFixed(4)} SOL
Accounts with Rent: ${summary.accountsWithRent}
Eligible for Reclaim: ${summary.accountsReclaimable}
Total Reclaimable: ${summary.totalReclaimable.toFixed(4)} SOL
    `);
  } catch (error) {
    logError("Check command failed", error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Handle 'reclaim' command
 */
async function handleReclaimCommand(argv: any) {
  try {
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
    const validator = new SafetyValidator(
      config.safety.whitelistMode,
      config.safety.whitelist,
      config.safety.blacklist,
      config.safety.minAccountAge,
      config.reclaimPolicy.maxReclaimPerBatch
    );

    // Load accounts
    let accounts = [];
    if (argv.file) {
      accounts = await scanner.loadAccountsFromFile(argv.file);
    } else if (argv.accounts && Array.isArray(argv.accounts)) {
      accounts = argv.accounts.map((addr: string) => ({
        address: addr,
        createdAt: new Date(),
      }));
    } else {
      accounts = await scanner.loadAccountsFromFile("./accounts.json");
    }

    if (accounts.length === 0) {
      logger.warn("No accounts to reclaim");
      return;
    }

    // Analyze accounts
    const analyzed = await scanner.analyzeAccounts(accounts);
    const reclaimCandidates = analyzed
      .filter((a) => a.rentStatus.canReclaim)
      .map((a) => ({
        address: a.address,
        rentStatus: a.rentStatus,
        createdAt: a.createdAt,
      }));

    if (reclaimCandidates.length === 0) {
      logger.info("No eligible accounts for reclaim");
      return;
    }

    logger.info(
      `Found ${reclaimCandidates.length} eligible accounts for reclaim`
    );

    // Validate batch
    const { approved, rejected } = validator.validateBatch(
      reclaimCandidates as any
    );

    logger.info(`Approved for reclaim: ${approved.length}`);
    if (rejected.length > 0) {
      logger.warn(`Rejected from reclaim: ${rejected.length}`);
      rejected.forEach((r) => {
        logger.warn(`  - ${r.account.address}: ${r.reason}`);
      });
    }

    if (approved.length === 0) {
      logger.warn("No approved accounts for reclaim");
      return;
    }

    // Prompt for approval if not specified
    if (!argv.approve && !config.safety.dryRun) {
      logger.warn(
        `About to reclaim from ${approved.length} accounts. This will send live transactions.`
      );
      logger.warn("Pass --approve flag to skip this prompt");
      return;
    }

    // Execute reclaim
    const handler = new ReclaimHandler(
      provider,
      config.treasuryAddress,
      argv["dry-run"] !== false ? config.safety.dryRun : argv["dry-run"]
    );

    const results = await handler.reclaimBatch(
      approved.map((a) => ({
        address: (a as any).address,
        rentAmount: (a as any).rentStatus.rentAmount,
      }))
    );

    const summary = handler.generateSummary(results);
    logger.info(`
=== Reclaim Summary ===
Successful: ${summary.successful}
Failed: ${summary.failed}
Total SOL Reclaimed: ${summary.totalReclaimed.toFixed(4)}
Success Rate: ${summary.successRate}%
    `);
  } catch (error) {
    logError("Reclaim command failed", error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Handle 'report' command
 */
async function handleReportCommand(argv: any) {
  try {
    const fromDate = argv["from-date"]
      ? new Date(argv["from-date"])
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const toDate = argv["to-date"] ? new Date(argv["to-date"]) : new Date();

    // For now, just generate a template report
    const mockResults: ReclaimResult[] = [];
    const config = Config.loadFromEnv();

    let reportContent = "";
    switch (argv.format) {
      case "csv":
        reportContent = SessionReporter.generateCsvReport(
          config.operatorName,
          fromDate,
          toDate,
          mockResults
        );
        break;
      case "html":
        reportContent = SessionReporter.generateHtmlReport(
          config.operatorName,
          fromDate,
          toDate,
          0,
          mockResults
        );
        break;
      case "json":
      default:
        const jsonReport = SessionReporter.generateJsonReport(
          config.operatorName,
          fromDate,
          toDate,
          0,
          mockResults
        );
        reportContent = JSON.stringify(jsonReport, null, 2);
    }

    console.log(reportContent);
  } catch (error) {
    logError("Report command failed", error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Handle 'config' command
 */
async function handleConfigCommand() {
  try {
    const config = Config.loadFromEnv();
    console.log(JSON.stringify(config, null, 2));
  } catch (error) {
    logError("Config command failed", error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Handle 'balance' command
 */
async function handleBalanceCommand() {
  try {
    const config = Config.loadFromEnv();
    const keypair = loadKeypair(
      process.env.OPERATOR_KEYPAIR_PATH || "./keys/operator-keypair.json"
    );
    const provider = new SolanaProvider(config.rpcUrl, keypair);

    const balance = await provider.getPayerBalance();
    console.log(`Operator balance: ${balance.toFixed(4)} SOL`);
  } catch (error) {
    logError("Balance command failed", error instanceof Error ? error : new Error(String(error)));
  }
}

// Run main
main();
