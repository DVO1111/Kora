#!/usr/bin/env node
/**
 * KORA RENT RECLAIM BOT - PROFESSIONAL CLI
 * 
 * A Kora operator installs this tool and finally understands:
 * - how much SOL is silently locked
 * - where it is locked
 * - which accounts are dead
 * - and gets their SOL back safely
 * 
 * COMMANDS:
 * - ingest:  Discover sponsored accounts from transaction history
 * - scan:    Check current status of all tracked accounts
 * - reclaim: Reclaim rent from eligible accounts (with safety checks)
 * - report:  Show historical metrics and reclaim history
 * - status:  Check a single account
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { KoraSponsorshipTracker } from "./core/sponsorshipTracker.js";
import { SafeRentReclaimer, DEFAULT_SAFETY_CONFIG } from "./core/safeReclaimer.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

interface Config {
  rpcUrl: string;
  operatorAddress: string;
  treasuryAddress: string;
  privateKeyPath?: string;
}

function loadConfig(): Config {
  const configPath = process.env.KORA_CONFIG || "config.json";
  let config: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // Ignore
    }
  }

  return {
    rpcUrl:
      process.env.SOLANA_RPC_URL ||
      (config.rpcUrl as string) ||
      "https://api.devnet.solana.com",
    operatorAddress:
      process.env.OPERATOR_ADDRESS || (config.operatorAddress as string) || "",
    treasuryAddress:
      process.env.TREASURY_ADDRESS || (config.treasuryAddress as string) || "",
    privateKeyPath:
      process.env.PRIVATE_KEY_PATH || (config.privateKeyPath as string),
  };
}

// ============================================================================
// DISPLAY HELPERS
// ============================================================================

function printBanner(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🤖  KORA RENT RECLAIM BOT                                  ║
║                                                              ║
║   Recover locked SOL from sponsored accounts                 ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
}

function formatSol(lamports: number): string {
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString();
}

// ============================================================================
// MAIN CLI
// ============================================================================

async function main() {
  const config = loadConfig();

  await yargs(hideBin(process.argv))
    .scriptName("kora-rent-bot")
    .usage("$0 <command> [options]")
    .option("rpc", {
      type: "string",
      description: "Solana RPC URL",
      default: config.rpcUrl,
    })
    .option("operator", {
      type: "string",
      description: "Operator wallet address",
    })

    // ========================================================================
    // INGEST COMMAND - Discover sponsored accounts
    // ========================================================================
    .command(
      "ingest",
      "Discover sponsored accounts from transaction history",
      (y) =>
        y.option("limit", {
          type: "number",
          description: "Max transactions to process",
          default: 500,
        }),
      async (args) => {
        printBanner();

        const operator = (args.operator as string) || config.operatorAddress;
        if (!operator) {
          console.error("❌ Error: --operator required");
          process.exit(1);
        }

        console.log(`📋 Configuration:`);
        console.log(`   Network:  ${args.rpc}`);
        console.log(`   Operator: ${operator}`);
        console.log(`   Limit:    ${args.limit} transactions`);

        const tracker = new KoraSponsorshipTracker(
          args.rpc as string,
          operator,
          "./data/sponsorship-registry.json"
        );

        const result = await tracker.ingestTransactionHistory(
          args.limit,
          (processed, found) => {
            process.stdout.write(
              `\r   Processing... ${processed} txs, ${found} accounts found`
            );
          }
        );

        console.log(`\n\n${"═".repeat(60)}`);
        console.log("               INGESTION COMPLETE");
        console.log(`${"═".repeat(60)}`);
        console.log(`   Transactions processed: ${result.transactionsProcessed}`);
        console.log(`   New accounts found:     ${result.newAccountsFound}`);
        console.log(`   Errors:                 ${result.errors}`);

        const metrics = tracker.getMetrics();
        console.log(`\n📊 Registry Totals:`);
        console.log(`   Total accounts tracked: ${metrics.totalAccountsSponsored}`);
        console.log(`   Total rent locked:      ${formatSol(metrics.totalRentLocked)}`);
        console.log(`   Total reclaimed:        ${formatSol(metrics.totalRentReclaimed)}`);
        console.log(`${"═".repeat(60)}\n`);
      }
    )

    // ========================================================================
    // SCAN COMMAND - Check current status of tracked accounts
    // ========================================================================
    .command(
      "scan",
      "Check current status of all tracked sponsored accounts",
      (y) => y,
      async (args) => {
        printBanner();

        const operator = (args.operator as string) || config.operatorAddress;
        if (!operator) {
          console.error("❌ Error: --operator required");
          process.exit(1);
        }

        console.log(`📋 Configuration:`);
        console.log(`   Network:  ${args.rpc}`);
        console.log(`   Operator: ${operator}`);

        const tracker = new KoraSponsorshipTracker(
          args.rpc as string,
          operator,
          "./data/sponsorship-registry.json"
        );

        const registry = tracker.getRegistry();
        if (registry.accounts.length === 0) {
          console.log(`\n⚠️ No sponsored accounts in registry.`);
          console.log(`   Run 'kora-rent-bot ingest' first to discover accounts.\n`);
          return;
        }

        console.log(`\n🔄 Refreshing status of ${registry.accounts.length} accounts...`);

        const result = await tracker.refreshAccountStatuses((checked, total) => {
          process.stdout.write(`\r   Checked ${checked}/${total}`);
        });

        const accounts = tracker.getSponsoredAccounts();
        const reclaimable = tracker.getReclaimableAccounts();
        const metrics = tracker.getMetrics();

        // Calculate totals
        let totalLocked = 0;
        let totalReclaimable = 0;

        for (const acc of accounts) {
          if (acc.status === "active") {
            totalLocked += acc.rentLamports;
          } else if (acc.status === "empty") {
            totalReclaimable += acc.rentLamports;
          }
        }

        console.log(`\n\n${"═".repeat(60)}`);
        console.log("             SPONSORED ACCOUNT SCAN RESULTS");
        console.log(`${"═".repeat(60)}`);
        console.log(`\n📊 Account Summary:`);
        console.log(`   Total sponsored accounts: ${accounts.length}`);
        console.log(`   🟢 Active (do not touch): ${result.active}`);
        console.log(`   ⚪ Closed / reclaimed:    ${result.closed}`);
        console.log(`   🔴 Empty / reclaimable:   ${result.empty}`);

        console.log(`\n💰 SOL Summary:`);
        console.log(`   Total rent locked:   ${formatSol(totalLocked)}`);
        console.log(`   ♻️  Reclaimable now:   ${formatSol(totalReclaimable)}`);

        if (reclaimable.length > 0) {
          console.log(`\n${"─".repeat(60)}`);
          console.log(`🔴 Reclaimable Accounts (${reclaimable.length}):\n`);

          for (const acc of reclaimable.slice(0, 10)) {
            console.log(`   Account:  ${acc.address.slice(0, 16)}...`);
            console.log(`   Type:     ${acc.accountType}`);
            console.log(`   Created:  ${formatDate(acc.createdAt)}`);
            console.log(`   Rent:     ${formatSol(acc.rentLamports)}`);
            console.log(`   Status:   ${acc.status.toUpperCase()}`);
            console.log();
          }

          if (reclaimable.length > 10) {
            console.log(`   ... and ${reclaimable.length - 10} more`);
          }
        }

        console.log(`\n📈 Historical Metrics:`);
        console.log(`   Total ever sponsored: ${metrics.totalAccountsSponsored}`);
        console.log(`   Total ever locked:    ${formatSol(metrics.totalRentLocked)}`);
        console.log(`   Total reclaimed:      ${formatSol(metrics.totalRentReclaimed)}`);
        console.log(`   Accounts closed:      ${metrics.totalAccountsClosed}`);

        if (metrics.totalRentLocked > 0) {
          const efficiency =
            (metrics.totalRentReclaimed / metrics.totalRentLocked) * 100;
          console.log(`   Reclaim efficiency:   ${efficiency.toFixed(1)}%`);
        }

        console.log(`${"═".repeat(60)}\n`);

        if (reclaimable.length > 0) {
          console.log(`💡 To reclaim, run:`);
          console.log(`   kora-rent-bot reclaim --dry-run`);
          console.log(`   kora-rent-bot reclaim --execute --key <keypair.json>\n`);
        }
      }
    )

    // ========================================================================
    // RECLAIM COMMAND - Execute reclaims with safety checks
    // ========================================================================
    .command(
      "reclaim",
      "Reclaim rent from eligible accounts (with safety checks)",
      (y) =>
        y
          .option("dry-run", {
            type: "boolean",
            description: "Simulate without executing",
            default: true,
          })
          .option("execute", {
            type: "boolean",
            description: "Actually execute reclaims",
            default: false,
          })
          .option("key", {
            type: "string",
            description: "Path to keypair JSON",
          })
          .option("treasury", {
            type: "string",
            description: "Treasury address for reclaimed SOL",
          })
          .option("min-age", {
            type: "number",
            description: "Minimum account age in days",
            default: 7,
          })
          .option("max-per-run", {
            type: "number",
            description: "Maximum accounts per run",
            default: 50,
          }),
      async (args) => {
        printBanner();

        const operator = (args.operator as string) || config.operatorAddress;
        const dryRun = !args.execute;

        if (!operator) {
          console.error("❌ Error: --operator required");
          process.exit(1);
        }

        const treasury = (args.treasury as string) || config.treasuryAddress || operator;
        const keyPath = (args.key as string) || config.privateKeyPath;

        if (!dryRun && !keyPath) {
          console.error("❌ Error: --key required for execution");
          process.exit(1);
        }

        console.log(`📋 Configuration:`);
        console.log(`   Network:   ${args.rpc}`);
        console.log(`   Operator:  ${operator}`);
        console.log(`   Treasury:  ${treasury}`);
        console.log(`   Mode:      ${dryRun ? "DRY RUN" : "EXECUTE"}`);
        console.log(`   Min Age:   ${args["min-age"]} days`);

        // Load tracker
        const tracker = new KoraSponsorshipTracker(
          args.rpc as string,
          operator,
          "./data/sponsorship-registry.json"
        );

        // Refresh statuses first
        console.log(`\n🔄 Refreshing account statuses...`);
        await tracker.refreshAccountStatuses();

        const reclaimable = tracker.getReclaimableAccounts();

        if (reclaimable.length === 0) {
          console.log(`\n✅ No reclaimable accounts found.\n`);
          return;
        }

        console.log(`   Found ${reclaimable.length} reclaimable accounts`);

        // Create reclaimer with safety config
        const reclaimer = new SafeRentReclaimer(
          args.rpc as string,
          dryRun ? null : keyPath || null,
          treasury,
          {
            minInactiveDays: args["min-age"] as number,
            maxAccountsPerRun: args["max-per-run"] as number,
          }
        );

        // Execute reclaim
        const report = await reclaimer.executeReclaim(
          reclaimable,
          dryRun,
          (account) => {
            // Record reclaim in tracker
            tracker.recordReclaim(account.address, account.rentLamports);
          }
        );

        if (!dryRun && report.accountsReclaimed > 0) {
          console.log(`\n✅ Successfully reclaimed ${formatSol(report.totalLamportsReclaimed)}`);
          console.log(`   Transaction signatures saved to ./data/reclaim-reports/`);
        }
      }
    )

    // ========================================================================
    // REPORT COMMAND - Show historical metrics
    // ========================================================================
    .command(
      "report",
      "Show historical metrics and reclaim history",
      (y) =>
        y.option("last", {
          type: "number",
          description: "Show last N reclaim runs",
          default: 5,
        }),
      async (args) => {
        printBanner();

        const operator = (args.operator as string) || config.operatorAddress;
        if (!operator) {
          console.error("❌ Error: --operator required");
          process.exit(1);
        }

        const tracker = new KoraSponsorshipTracker(
          args.rpc as string,
          operator,
          "./data/sponsorship-registry.json"
        );

        const registry = tracker.getRegistry();
        const metrics = tracker.getMetrics();

        console.log(`${"═".repeat(60)}`);
        console.log("               OPERATOR METRICS REPORT");
        console.log(`${"═".repeat(60)}`);
        console.log(`\n📋 Operator: ${operator}`);
        console.log(`   Registry created: ${registry.createdAt}`);
        console.log(`   Last updated:     ${registry.lastUpdated}`);

        console.log(`\n📊 Lifetime Metrics:`);
        console.log(`   ┌─────────────────────────────────────────┐`);
        console.log(`   │ Total accounts sponsored:  ${String(metrics.totalAccountsSponsored).padStart(10)} │`);
        console.log(`   │ Total rent locked:         ${formatSol(metrics.totalRentLocked).padStart(10)} │`);
        console.log(`   │ Total rent reclaimed:      ${formatSol(metrics.totalRentReclaimed).padStart(10)} │`);
        console.log(`   │ Accounts closed:           ${String(metrics.totalAccountsClosed).padStart(10)} │`);
        console.log(`   └─────────────────────────────────────────┘`);

        if (metrics.totalRentLocked > 0) {
          const efficiency =
            (metrics.totalRentReclaimed / metrics.totalRentLocked) * 100;
          const remaining = metrics.totalRentLocked - metrics.totalRentReclaimed;

          console.log(`\n💰 Financial Summary:`);
          console.log(`   Reclaim efficiency: ${efficiency.toFixed(1)}%`);
          console.log(`   Remaining locked:   ${formatSol(remaining)}`);
        }

        // Load recent reclaim reports
        const reportsPath = "./data/reclaim-reports";
        if (fs.existsSync(reportsPath)) {
          const reports = fs
            .readdirSync(reportsPath)
            .filter((f) => f.endsWith(".json"))
            .sort()
            .reverse()
            .slice(0, args.last);

          if (reports.length > 0) {
            console.log(`\n📜 Recent Reclaim Runs (last ${reports.length}):\n`);

            for (const reportFile of reports) {
              const report = JSON.parse(
                fs.readFileSync(`${reportsPath}/${reportFile}`, "utf-8")
              );
              console.log(`   ${report.timestamp}`);
              console.log(`      Mode: ${report.dryRun ? "Dry Run" : "Executed"}`);
              console.log(`      Accounts: ${report.accountsReclaimed}/${report.accountsAnalyzed}`);
              console.log(`      Reclaimed: ${formatSol(report.totalLamportsReclaimed)}`);
              console.log();
            }
          }
        }

        console.log(`${"═".repeat(60)}\n`);
      }
    )

    // ========================================================================
    // STATUS COMMAND - Check single account
    // ========================================================================
    .command(
      "status <address>",
      "Check status of a specific account",
      (y) =>
        y.positional("address", {
          type: "string",
          description: "Account address",
          demandOption: true,
        }),
      async (args) => {
        const connection = new Connection(args.rpc as string, "confirmed");
        const address = args.address as string;

        console.log(`\n📋 Account Status: ${address}\n`);
        console.log(`${"─".repeat(50)}`);

        try {
          const pubkey = new PublicKey(address);
          const info = await connection.getAccountInfo(pubkey);

          if (!info) {
            console.log(`   Status:      CLOSED (does not exist)`);
            console.log(`   Reclaimable: No (already closed)`);
          } else {
            const minRent = await connection.getMinimumBalanceForRentExemption(
              info.data.length
            );
            const isEmpty =
              info.data.length === 0 || info.data.every((b) => b === 0);

            console.log(`   Exists:      Yes`);
            console.log(`   Balance:     ${formatSol(info.lamports)}`);
            console.log(`   Owner:       ${info.owner.toString()}`);
            console.log(`   Data Size:   ${info.data.length} bytes`);
            console.log(`   Rent Exempt: ${info.lamports >= minRent ? "Yes" : "No"}`);
            console.log(`   Is Empty:    ${isEmpty ? "Yes" : "No"}`);
            console.log(
              `   Reclaimable: ${isEmpty ? "YES ✓" : "No (has data)"}`
            );
          }

          // Check recent activity
          const signatures = await connection.getSignaturesForAddress(pubkey, {
            limit: 3,
          });

          if (signatures.length > 0) {
            console.log(`\n   Recent Activity:`);
            for (const sig of signatures) {
              const date = sig.blockTime
                ? new Date(sig.blockTime * 1000).toISOString()
                : "unknown";
              console.log(`      ${date} - ${sig.signature.slice(0, 20)}...`);
            }
          } else {
            console.log(`\n   Recent Activity: None`);
          }
        } catch (error) {
          console.log(`   Error: ${(error as Error).message}`);
        }

        console.log(`${"─".repeat(50)}\n`);
      }
    )

    .demandCommand(1, "Please specify a command")
    .help()
    .version("1.0.0")
    .parse();
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
