#!/usr/bin/env node
/**
 * Kora Rent Reclaim Bot - Professional CLI
 * 
 * Helps Kora operators:
 * 1. See which sponsored accounts locked their SOL
 * 2. Identify which accounts are safe to reclaim
 * 3. Recover locked SOL back to treasury
 * 4. Understand why each reclaim happened
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// TYPES
// ============================================================================

interface AccountStatus {
  address: string;
  exists: boolean;
  lamports: number;
  owner: string;
  dataSize: number;
  isRentExempt: boolean;
  classification: "active" | "closed" | "reclaimable" | "unknown";
  reason: string;
  lastActivity?: Date;
}

interface ScanResult {
  totalAccounts: number;
  activeAccounts: number;
  closedAccounts: number;
  reclaimableAccounts: number;
  totalRentLocked: number;
  reclaimableAmount: number;
  accounts: AccountStatus[];
}

interface ReclaimLog {
  timestamp: string;
  account: string;
  lamports: number;
  sol: number;
  reason: string;
  txSignature?: string;
  status: "success" | "failed" | "dry-run";
  error?: string;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

function loadConfig(): {
  rpcUrl: string;
  operatorAddress: string;
  treasuryAddress: string;
  privateKeyPath?: string;
} {
  const configPath = process.env.KORA_CONFIG || "config.json";
  let config: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // Ignore parse errors
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
// ACCOUNT CLASSIFICATION LOGIC
// ============================================================================

async function classifyAccount(
  connection: Connection,
  address: string
): Promise<AccountStatus> {
  const pubkey = new PublicKey(address);

  try {
    const accountInfo = await connection.getAccountInfo(pubkey);

    // Account doesn't exist = already closed
    if (!accountInfo) {
      return {
        address,
        exists: false,
        lamports: 0,
        owner: "",
        dataSize: 0,
        isRentExempt: false,
        classification: "closed",
        reason: "Account already closed on-chain",
      };
    }

    const minRent = await connection.getMinimumBalanceForRentExemption(
      accountInfo.data.length
    );

    const owner = accountInfo.owner.toString();
    const dataSize = accountInfo.data.length;
    const lamports = accountInfo.lamports;
    const isRentExempt = lamports >= minRent;

    // Check if data is empty (all zeros)
    const isDataEmpty =
      dataSize === 0 || accountInfo.data.every((byte) => byte === 0);

    // Classification logic based on bounty requirements
    let classification: AccountStatus["classification"] = "unknown";
    let reason = "";

    // System Program owned, no data = empty system account, safe to reclaim
    if (owner === SystemProgram.programId.toString() && dataSize === 0) {
      classification = "reclaimable";
      reason = "Empty system account, 0 data bytes - safe to reclaim";
    }
    // Token account with zero balance
    else if (owner === TOKEN_PROGRAM_ID.toString() && dataSize === 165) {
      // Check if token account has zero balance
      try {
        const tokenAccount = await getAccount(connection, pubkey);
        if (tokenAccount.amount === 0n) {
          classification = "reclaimable";
          reason = "Token account with zero balance - safe to close";
        } else {
          classification = "active";
          reason = `Token account with ${tokenAccount.amount} tokens - DO NOT TOUCH`;
        }
      } catch {
        classification = "reclaimable";
        reason = "Token account appears empty/invalid - likely reclaimable";
      }
    }
    // Program owned with data = active
    else if (dataSize > 0 && !isDataEmpty) {
      classification = "active";
      reason = `Program-owned account with ${dataSize} bytes data - DO NOT TOUCH`;
    }
    // Has data but it's all zeros = potentially reclaimable
    else if (dataSize > 0 && isDataEmpty) {
      classification = "reclaimable";
      reason = `Account data is zeroed (${dataSize} bytes) - likely abandoned`;
    }
    // Below rent exempt = draining/stale
    else if (!isRentExempt) {
      classification = "reclaimable";
      reason = "Below rent-exempt threshold - stale account";
    }
    // Default to active for safety
    else {
      classification = "active";
      reason = "Unknown state - treating as active for safety";
    }

    return {
      address,
      exists: true,
      lamports,
      owner,
      dataSize,
      isRentExempt,
      classification,
      reason,
    };
  } catch (error) {
    return {
      address,
      exists: false,
      lamports: 0,
      owner: "",
      dataSize: 0,
      isRentExempt: false,
      classification: "unknown",
      reason: `Error checking account: ${(error as Error).message}`,
    };
  }
}

// ============================================================================
// ACCOUNT DISCOVERY
// ============================================================================

async function discoverSponsoredAccounts(
  connection: Connection,
  operatorAddress: string,
  limit: number
): Promise<string[]> {
  const accounts: string[] = [];
  const operator = new PublicKey(operatorAddress);

  console.log(`\n🔍 Discovering accounts sponsored by ${operatorAddress}...`);

  try {
    // Get transaction history
    const signatures = await connection.getSignaturesForAddress(operator, {
      limit,
    });

    console.log(`   Found ${signatures.length} transactions to analyze\n`);

    // Process in small batches to avoid rate limits
    const batchSize = 2;
    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);

      for (const sig of batch) {
        try {
          const tx = await connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (!tx || tx.meta?.err) continue;

          // Check if operator was fee payer
          const feePayer = tx.transaction.message.accountKeys[0]?.pubkey;
          if (feePayer?.toString() !== operatorAddress) continue;

          // Look for account creation
          for (const ix of tx.transaction.message.instructions) {
            if ("parsed" in ix && ix.parsed?.type === "createAccount") {
              const newAccount = ix.parsed.info?.newAccount;
              if (newAccount && !accounts.includes(newAccount)) {
                accounts.push(newAccount);
              }
            }
            if ("parsed" in ix && ix.program === "spl-associated-token-account") {
              const account = ix.parsed?.info?.account;
              if (account && !accounts.includes(account)) {
                accounts.push(account);
              }
            }
          }
        } catch {
          // Skip failed transaction fetches
        }
      }

      // Rate limiting
      if (i + batchSize < signatures.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (error) {
    console.log(`   ⚠️ Discovery limited: ${(error as Error).message}`);
  }

  return accounts;
}

// ============================================================================
// SCAN COMMAND
// ============================================================================

async function scanAccounts(
  connection: Connection,
  accounts: string[]
): Promise<ScanResult> {
  const result: ScanResult = {
    totalAccounts: accounts.length,
    activeAccounts: 0,
    closedAccounts: 0,
    reclaimableAccounts: 0,
    totalRentLocked: 0,
    reclaimableAmount: 0,
    accounts: [],
  };

  for (let i = 0; i < accounts.length; i++) {
    const status = await classifyAccount(connection, accounts[i]);
    result.accounts.push(status);

    switch (status.classification) {
      case "active":
        result.activeAccounts++;
        result.totalRentLocked += status.lamports;
        break;
      case "closed":
        result.closedAccounts++;
        break;
      case "reclaimable":
        result.reclaimableAccounts++;
        result.reclaimableAmount += status.lamports;
        result.totalRentLocked += status.lamports;
        break;
    }

    // Rate limiting
    if (i < accounts.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return result;
}

function printScanResult(result: ScanResult): void {
  console.log(`\n${"═".repeat(50)}`);
  console.log(`           SPONSORED ACCOUNT SCAN RESULTS`);
  console.log(`${"═".repeat(50)}\n`);

  console.log(`📊 Account Summary:`);
  console.log(`   Total sponsored accounts: ${result.totalAccounts}`);
  console.log(`   🟢 Active (do not touch): ${result.activeAccounts}`);
  console.log(`   ⚪ Closed / empty:        ${result.closedAccounts}`);
  console.log(`   🔴 Stale / reclaimable:   ${result.reclaimableAccounts}`);

  console.log(`\n💰 SOL Summary:`);
  console.log(
    `   Total rent locked:  ${(result.totalRentLocked / LAMPORTS_PER_SOL).toFixed(6)} SOL`
  );
  console.log(
    `   ♻️  Reclaimable now:  ${(result.reclaimableAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL`
  );

  if (result.reclaimableAccounts > 0) {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`🔴 Reclaimable Accounts:\n`);

    for (const account of result.accounts) {
      if (account.classification === "reclaimable") {
        console.log(`   Account: ${account.address.slice(0, 12)}...`);
        console.log(`   Reason:  ${account.reason}`);
        console.log(
          `   Rent:    ${(account.lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`
        );
        console.log();
      }
    }
  }

  console.log(`${"═".repeat(50)}\n`);
}

// ============================================================================
// RECLAIM COMMAND
// ============================================================================

async function reclaimRent(
  connection: Connection,
  accounts: AccountStatus[],
  treasury: PublicKey,
  keypair: Keypair | null,
  dryRun: boolean
): Promise<ReclaimLog[]> {
  const logs: ReclaimLog[] = [];
  const reclaimable = accounts.filter((a) => a.classification === "reclaimable");

  if (reclaimable.length === 0) {
    console.log("\n✅ No reclaimable accounts found.\n");
    return logs;
  }

  console.log(`\n${"═".repeat(50)}`);
  if (dryRun) {
    console.log(`       ⚠️  DRY RUN MODE (no transactions sent)`);
  } else {
    console.log(`       🚀 EXECUTING RECLAIMS`);
  }
  console.log(`${"═".repeat(50)}\n`);

  let totalReclaimed = 0;

  for (const account of reclaimable) {
    const log: ReclaimLog = {
      timestamp: new Date().toISOString(),
      account: account.address,
      lamports: account.lamports,
      sol: account.lamports / LAMPORTS_PER_SOL,
      reason: account.reason,
      status: dryRun ? "dry-run" : "success",
    };

    console.log(`   Account: ${account.address.slice(0, 12)}...`);
    console.log(`   Reason:  ${account.reason}`);
    console.log(`   Rent to reclaim: ${log.sol.toFixed(6)} SOL`);

    if (!dryRun && keypair) {
      try {
        // Determine how to close the account
        if (account.owner === TOKEN_PROGRAM_ID.toString()) {
          // Close token account
          const closeIx = createCloseAccountInstruction(
            new PublicKey(account.address),
            treasury,
            keypair.publicKey
          );
          const tx = new Transaction().add(closeIx);
          const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
          log.txSignature = sig;
          console.log(`   ✅ Tx: ${sig.slice(0, 20)}...`);
        } else {
          // Transfer lamports from system account
          // Note: This requires the keypair to own the account
          console.log(`   ⚠️ Manual intervention needed for non-token account`);
          log.status = "failed";
          log.error = "Cannot automatically close non-token accounts";
        }
      } catch (error) {
        log.status = "failed";
        log.error = (error as Error).message;
        console.log(`   ❌ Failed: ${log.error}`);
      }
    } else if (dryRun) {
      console.log(`   📋 Would reclaim ${log.sol.toFixed(6)} SOL`);
    }

    if (log.status !== "failed") {
      totalReclaimed += account.lamports;
    }

    logs.push(log);
    console.log();
  }

  console.log(`${"─".repeat(50)}`);
  if (dryRun) {
    console.log(
      `\n📋 Total reclaimable: ${(totalReclaimed / LAMPORTS_PER_SOL).toFixed(6)} SOL`
    );
    console.log(`\n💡 Run with --execute to reclaim these funds.\n`);
  } else {
    console.log(
      `\n✅ Total reclaimed: ${(totalReclaimed / LAMPORTS_PER_SOL).toFixed(6)} SOL`
    );
  }

  return logs;
}

// ============================================================================
// LOGGING
// ============================================================================

function saveReclaimLogs(logs: ReclaimLog[], outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Append to existing logs
  let existingLogs: ReclaimLog[] = [];
  if (fs.existsSync(outputPath)) {
    try {
      existingLogs = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    } catch {
      existingLogs = [];
    }
  }

  const allLogs = [...existingLogs, ...logs];
  fs.writeFileSync(outputPath, JSON.stringify(allLogs, null, 2));
  console.log(`📝 Logs saved to ${outputPath}\n`);
}

// ============================================================================
// CLI
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
      description: "Operator address (fee payer)",
    })

    // SCAN command
    .command(
      "scan",
      "Scan sponsored accounts and show rent status",
      (y) =>
        y
          .option("limit", {
            type: "number",
            description: "Max transactions to scan",
            default: 100,
          })
          .option("accounts", {
            type: "string",
            description: "JSON file with account addresses",
          }),
      async (args) => {
        const connection = new Connection(args.rpc as string, "confirmed");
        const operator = (args.operator as string) || config.operatorAddress;

        if (!operator) {
          console.error("❌ Error: --operator address required");
          process.exit(1);
        }

        console.log(`\n🤖 Kora Rent Reclaim Bot`);
        console.log(`   Network: ${args.rpc}`);
        console.log(`   Operator: ${operator}`);

        // Get accounts to scan
        let accounts: string[] = [];

        if (args.accounts) {
          // Load from file
          const data = JSON.parse(fs.readFileSync(args.accounts as string, "utf-8"));
          accounts = Array.isArray(data) ? data : data.accounts || [];
          console.log(`   Loaded ${accounts.length} accounts from file`);
        } else {
          // Discover from chain
          accounts = await discoverSponsoredAccounts(
            connection,
            operator,
            args.limit
          );
        }

        if (accounts.length === 0) {
          console.log("\n⚠️ No sponsored accounts found.\n");
          console.log("Tip: Provide accounts via --accounts file.json\n");
          return;
        }

        console.log(`\n🔍 Scanning ${accounts.length} accounts...`);
        const result = await scanAccounts(connection, accounts);
        printScanResult(result);

        // Save scan results
        const outputPath = "./logs/scan-result.json";
        if (!fs.existsSync("./logs")) fs.mkdirSync("./logs");
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
        console.log(`📝 Full scan saved to ${outputPath}\n`);
      }
    )

    // RECLAIM command
    .command(
      "reclaim",
      "Reclaim rent from eligible accounts",
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
            description: "Path to keypair JSON file",
          })
          .option("treasury", {
            type: "string",
            description: "Treasury address for reclaimed SOL",
          })
          .option("accounts", {
            type: "string",
            description: "JSON file with account addresses",
          })
          .option("limit", {
            type: "number",
            description: "Max transactions to scan",
            default: 100,
          }),
      async (args) => {
        const connection = new Connection(args.rpc as string, "confirmed");
        const operator = (args.operator as string) || config.operatorAddress;
        const dryRun = !args.execute;

        if (!operator) {
          console.error("❌ Error: --operator address required");
          process.exit(1);
        }

        const treasury = new PublicKey(
          (args.treasury as string) || config.treasuryAddress || operator
        );

        // Load keypair if executing
        let keypair: Keypair | null = null;
        if (!dryRun) {
          const keyPath = (args.key as string) || config.privateKeyPath;
          if (!keyPath || !fs.existsSync(keyPath)) {
            console.error("❌ Error: --key required for execution");
            process.exit(1);
          }
          const keyData = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
          keypair = Keypair.fromSecretKey(Uint8Array.from(keyData));
        }

        console.log(`\n🤖 Kora Rent Reclaim Bot`);
        console.log(`   Network: ${args.rpc}`);
        console.log(`   Operator: ${operator}`);
        console.log(`   Treasury: ${treasury.toString()}`);
        console.log(`   Mode: ${dryRun ? "DRY RUN" : "EXECUTE"}`);

        // Get accounts
        let accounts: string[] = [];
        if (args.accounts) {
          const data = JSON.parse(fs.readFileSync(args.accounts as string, "utf-8"));
          accounts = Array.isArray(data) ? data : data.accounts || [];
        } else {
          accounts = await discoverSponsoredAccounts(
            connection,
            operator,
            args.limit as number
          );
        }

        if (accounts.length === 0) {
          console.log("\n⚠️ No accounts to process.\n");
          return;
        }

        // Scan and classify
        console.log(`\n🔍 Analyzing ${accounts.length} accounts...`);
        const scanResult = await scanAccounts(connection, accounts);
        printScanResult(scanResult);

        // Reclaim
        const logs = await reclaimRent(
          connection,
          scanResult.accounts,
          treasury,
          keypair,
          dryRun
        );

        // Save logs
        if (logs.length > 0) {
          saveReclaimLogs(logs, "./logs/reclaims.json");
        }
      }
    )

    // STATUS command
    .command(
      "status",
      "Check a specific account status",
      (y) =>
        y.option("address", {
          type: "string",
          description: "Account address to check",
          demandOption: true,
        }),
      async (args) => {
        const connection = new Connection(args.rpc as string, "confirmed");
        const status = await classifyAccount(connection, args.address as string);

        console.log(`\n📋 Account Status`);
        console.log(`${"─".repeat(40)}`);
        console.log(`Address:        ${status.address}`);
        console.log(`Exists:         ${status.exists ? "Yes" : "No"}`);
        console.log(
          `Balance:        ${(status.lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`
        );
        console.log(`Owner:          ${status.owner || "N/A"}`);
        console.log(`Data Size:      ${status.dataSize} bytes`);
        console.log(`Rent Exempt:    ${status.isRentExempt ? "Yes" : "No"}`);
        console.log(`Classification: ${status.classification.toUpperCase()}`);
        console.log(`Reason:         ${status.reason}`);
        console.log();
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
