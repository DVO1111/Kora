#!/usr/bin/env node
/**
 * Demo script - runs the Kora Rent Reclaim Bot against sample accounts
 * This bypasses the transaction history discovery and directly checks known accounts
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

interface AccountAnalysis {
  address: string;
  exists: boolean;
  balance: number;
  owner: string;
  dataSize: number;
  isRentExempt: boolean;
  canReclaim: boolean;
  reason: string;
}

async function analyzeAccount(
  connection: Connection,
  address: string
): Promise<AccountAnalysis> {
  try {
    const pubkey = new PublicKey(address);
    const accountInfo = await connection.getAccountInfo(pubkey);

    if (!accountInfo) {
      return {
        address,
        exists: false,
        balance: 0,
        owner: "",
        dataSize: 0,
        isRentExempt: false,
        canReclaim: false,
        reason: "Account does not exist - already closed or never existed",
      };
    }

    const minRent = await connection.getMinimumBalanceForRentExemption(
      accountInfo.data.length
    );

    const isEmpty =
      accountInfo.data.length === 0 ||
      accountInfo.data.every((byte) => byte === 0);

    const isRentExempt = accountInfo.lamports >= minRent;

    let canReclaim = false;
    let reason = "";

    if (isEmpty && accountInfo.data.length === 0) {
      canReclaim = true;
      reason = "Empty system account - rent can be reclaimed";
    } else if (isEmpty) {
      canReclaim = true;
      reason = "Account data is zeroed - potentially reclaimable";
    } else {
      canReclaim = false;
      reason = "Account has active data - cannot close";
    }

    return {
      address,
      exists: true,
      balance: accountInfo.lamports / LAMPORTS_PER_SOL,
      owner: accountInfo.owner.toString(),
      dataSize: accountInfo.data.length,
      isRentExempt,
      canReclaim,
      reason,
    };
  } catch (error) {
    return {
      address,
      exists: false,
      balance: 0,
      owner: "",
      dataSize: 0,
      isRentExempt: false,
      canReclaim: false,
      reason: `Error: ${(error as Error).message}`,
    };
  }
}

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║    Kora Rent Reclaim Bot - Demo Mode      ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log();

  const connection = new Connection(RPC_URL, "confirmed");
  console.log(`🔗 Connected to: ${RPC_URL}`);
  console.log();

  // Sample addresses to analyze (these are program addresses for demo)
  const sampleAddresses = [
    "11111111111111111111111111111111", // System Program
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
  ];

  // Get command line address if provided
  const cliAddress = process.argv[2];
  if (cliAddress) {
    sampleAddresses.unshift(cliAddress);
    console.log(`📍 Checking custom address: ${cliAddress}`);
    console.log();
  }

  console.log("🔍 Analyzing accounts...");
  console.log();

  let totalReclaimable = 0;
  let reclaimableCount = 0;

  for (const address of sampleAddresses) {
    // Add delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 500));

    const analysis = await analyzeAccount(connection, address);

    console.log(`┌─ Account: ${analysis.address.slice(0, 20)}...`);
    console.log(`│  Exists: ${analysis.exists ? "✅ Yes" : "❌ No"}`);

    if (analysis.exists) {
      console.log(`│  Balance: ${analysis.balance.toFixed(6)} SOL`);
      console.log(`│  Owner: ${analysis.owner.slice(0, 20)}...`);
      console.log(`│  Data Size: ${analysis.dataSize} bytes`);
      console.log(`│  Rent Exempt: ${analysis.isRentExempt ? "✅" : "❌"}`);
      console.log(
        `│  Can Reclaim: ${analysis.canReclaim ? "✅ YES" : "❌ No"}`
      );

      if (analysis.canReclaim) {
        totalReclaimable += analysis.balance;
        reclaimableCount++;
      }
    }

    console.log(`└─ Status: ${analysis.reason}`);
    console.log();
  }

  console.log("════════════════════════════════════════════");
  console.log("                  SUMMARY                   ");
  console.log("════════════════════════════════════════════");
  console.log(`  Accounts Analyzed:  ${sampleAddresses.length}`);
  console.log(`  Reclaimable:        ${reclaimableCount}`);
  console.log(`  Total Reclaimable:  ${totalReclaimable.toFixed(6)} SOL`);
  console.log("════════════════════════════════════════════");

  if (reclaimableCount > 0) {
    console.log();
    console.log("💡 To reclaim rent, run:");
    console.log("   node dist/cli.js reclaim --operator <YOUR_ADDRESS> --key <PATH_TO_KEY>");
  }
}

main().catch(console.error);
