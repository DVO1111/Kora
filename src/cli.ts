#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import * as fs from "fs";
import * as path from "path";
import { KoraRentReclaimBot, BotConfig } from "./core/bot.js";
import logger from "./logger.js";

// Load config from file or environment
function loadConfig(): BotConfig {
  const configPath = process.env.KORA_CONFIG || "config.json";

  let fileConfig: Partial<BotConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (error) {
      logger.warn(`Failed to parse config file: ${configPath}`);
    }
  }

  return {
    rpcUrl:
      process.env.SOLANA_RPC_URL ||
      fileConfig.rpcUrl ||
      "https://api.devnet.solana.com",
    operatorAddress:
      process.env.OPERATOR_ADDRESS || fileConfig.operatorAddress || "",
    treasuryAddress:
      process.env.TREASURY_ADDRESS || fileConfig.treasuryAddress || "",
    privateKeyPath:
      process.env.PRIVATE_KEY_PATH || fileConfig.privateKeyPath,
    accountsFile: fileConfig.accountsFile,
    minAccountAge: fileConfig.minAccountAge || 0,
    whitelist: fileConfig.whitelist || [],
    blacklist: fileConfig.blacklist || [],
    dryRun: fileConfig.dryRun !== false,
    maxTransactionsPerRun: fileConfig.maxTransactionsPerRun || 10,
  };
}

// Merge CLI args with config
function mergeConfig(
  baseConfig: BotConfig,
  args: { [key: string]: unknown }
): BotConfig {
  return {
    ...baseConfig,
    rpcUrl: (args.rpc as string) || baseConfig.rpcUrl,
    operatorAddress: (args.operator as string) || baseConfig.operatorAddress,
    treasuryAddress: (args.treasury as string) || baseConfig.treasuryAddress,
    dryRun: args.dryRun !== undefined ? (args.dryRun as boolean) : baseConfig.dryRun,
  };
}

async function main() {
  const baseConfig = loadConfig();

  await yargs(hideBin(process.argv))
    .scriptName("kora-bot")
    .usage("$0 <command> [options]")
    .option("rpc", {
      type: "string",
      description: "Solana RPC URL",
      default: baseConfig.rpcUrl,
    })
    .option("operator", {
      type: "string",
      description: "Operator wallet address",
    })
    .option("treasury", {
      type: "string",
      description: "Treasury address to receive reclaimed SOL",
    })

    // Check command - analyze accounts
    .command(
      "check",
      "Check sponsored accounts for reclaimable rent",
      (yargs) =>
        yargs
          .option("limit", {
            type: "number",
            description: "Maximum transactions to scan",
            default: 500,
          })
          .option("output", {
            type: "string",
            description: "Export results to file",
          }),
      async (args) => {
        const config = mergeConfig(baseConfig, args);

        if (!config.operatorAddress) {
          console.error(
            "Error: Operator address is required. Use --operator or set OPERATOR_ADDRESS"
          );
          process.exit(1);
        }

        config.treasuryAddress = config.treasuryAddress || config.operatorAddress;

        const bot = new KoraRentReclaimBot(config);
        const stats = await bot.check(args.limit);

        if (args.output) {
          await bot.exportAccounts(args.output as string);
        }

        console.log("\n📊 Summary:");
        console.log(`   Accounts found: ${stats.accountsDiscovered}`);
        console.log(`   Reclaimable: ${stats.reclaimableAccounts}`);
        console.log(`   Total reclaimable: ${stats.totalReclaimable.toFixed(6)} SOL`);
      }
    )

    // Reclaim command - execute reclaims
    .command(
      "reclaim",
      "Reclaim rent from eligible accounts",
      (yargs) =>
        yargs
          .option("limit", {
            type: "number",
            description: "Maximum transactions to scan",
            default: 500,
          })
          .option("dry-run", {
            type: "boolean",
            description: "Simulate without executing",
            default: true,
          })
          .option("max-tx", {
            type: "number",
            description: "Maximum reclaim transactions per run",
            default: 10,
          })
          .option("key", {
            type: "string",
            description: "Path to private key file",
          }),
      async (args) => {
        const config = mergeConfig(baseConfig, args);
        config.dryRun = args["dry-run"] as boolean;
        config.maxTransactionsPerRun = args["max-tx"] as number;
        config.privateKeyPath = (args.key as string) || config.privateKeyPath;

        if (!config.operatorAddress) {
          console.error("Error: Operator address is required");
          process.exit(1);
        }

        if (!config.dryRun && !config.privateKeyPath) {
          console.error(
            "Error: Private key is required for live reclaim. Use --key or set PRIVATE_KEY_PATH"
          );
          process.exit(1);
        }

        config.treasuryAddress = config.treasuryAddress || config.operatorAddress;

        const bot = new KoraRentReclaimBot(config);
        const stats = await bot.reclaim(args.limit);

        if (config.dryRun) {
          console.log("\n🔍 Dry Run Complete:");
        } else {
          console.log("\n✅ Reclaim Complete:");
        }
        console.log(`   Successful: ${stats.successfulReclaims}`);
        console.log(`   Failed: ${stats.failedReclaims}`);
        console.log(`   Total reclaimed: ${stats.totalReclaimed.toFixed(6)} SOL`);
      }
    )

    // Balance command - check balances
    .command(
      "balance",
      "Check operator and treasury balances",
      (yargs) => yargs,
      async (args) => {
        const config = mergeConfig(baseConfig, args);

        if (!config.operatorAddress) {
          console.error("Error: Operator address is required");
          process.exit(1);
        }

        config.treasuryAddress = config.treasuryAddress || config.operatorAddress;

        const bot = new KoraRentReclaimBot(config);

        const operatorBalance = await bot.getOperatorBalance();
        const treasuryBalance = await bot.getTreasuryBalance();

        console.log("\n💰 Balances:");
        console.log(`   Operator: ${operatorBalance.toFixed(6)} SOL`);
        console.log(`   Treasury: ${treasuryBalance.toFixed(6)} SOL`);
      }
    )

    // Account command - check specific account
    .command(
      "account <address>",
      "Get details for a specific account",
      (yargs) =>
        yargs.positional("address", {
          type: "string",
          description: "Account address to check",
          demandOption: true,
        }),
      async (args) => {
        const config = mergeConfig(baseConfig, args);
        config.operatorAddress = config.operatorAddress || "11111111111111111111111111111111";
        config.treasuryAddress = config.treasuryAddress || config.operatorAddress;

        const bot = new KoraRentReclaimBot(config);
        const detail = await bot.getAccountDetail(args.address as string);

        console.log("\n📋 Account Details:");
        console.log(`   Address: ${detail.address}`);
        console.log(`   Exists: ${detail.exists}`);
        if (detail.exists) {
          console.log(`   Balance: ${detail.balance.toFixed(6)} SOL`);
          console.log(`   Owner: ${detail.owner}`);
          console.log(`   Data Size: ${detail.dataLength} bytes`);
          console.log(`   Rent Exempt: ${detail.isRentExempt}`);
          console.log(`   Can Reclaim: ${detail.canReclaim}`);
          console.log(`   Status: ${detail.reason}`);
        }
      }
    )

    // Config command - show configuration
    .command(
      "config",
      "Show current configuration",
      (yargs) => yargs,
      async () => {
        const config = baseConfig;
        console.log("\n⚙️  Configuration:");
        console.log(`   RPC URL: ${config.rpcUrl}`);
        console.log(`   Operator: ${config.operatorAddress || "(not set)"}`);
        console.log(`   Treasury: ${config.treasuryAddress || "(not set)"}`);
        console.log(`   Private Key: ${config.privateKeyPath || "(not set)"}`);
        console.log(`   Accounts File: ${config.accountsFile || "(not set)"}`);
        console.log(`   Min Account Age: ${config.minAccountAge} days`);
        console.log(`   Dry Run: ${config.dryRun}`);
        console.log(`   Max TX/Run: ${config.maxTransactionsPerRun}`);
      }
    )

    // Init command - create config file
    .command(
      "init",
      "Initialize configuration file",
      (yargs) =>
        yargs.option("force", {
          type: "boolean",
          description: "Overwrite existing config",
          default: false,
        }),
      async (args) => {
        const configPath = "config.json";

        if (fs.existsSync(configPath) && !args.force) {
          console.error(
            "Config file already exists. Use --force to overwrite."
          );
          process.exit(1);
        }

        const template: BotConfig = {
          rpcUrl: "https://api.devnet.solana.com",
          operatorAddress: "YOUR_OPERATOR_ADDRESS",
          treasuryAddress: "YOUR_TREASURY_ADDRESS",
          privateKeyPath: "./keypair.json",
          accountsFile: "./accounts.json",
          minAccountAge: 7,
          whitelist: [],
          blacklist: [],
          dryRun: true,
          maxTransactionsPerRun: 10,
        };

        fs.writeFileSync(configPath, JSON.stringify(template, null, 2));
        console.log(`✅ Created ${configPath}`);
        console.log("   Edit this file with your settings before running the bot.");
      }
    )

    .demandCommand(1, "Please specify a command")
    .help()
    .version("1.0.0")
    .parse();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
