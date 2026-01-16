# Kora Rent-Reclaim Bot - Deep Dive Documentation

## Table of Contents

1. [Introduction](#introduction)
2. [Understanding Solana Rent](#understanding-solana-rent)
3. [How Kora Sponsorship Works](#how-kora-sponsorship-works)
4. [The Rent-Locking Problem](#the-rent-locking-problem)
5. [Our Solution Architecture](#our-solution-architecture)
6. [Technical Implementation](#technical-implementation)
7. [Safety Mechanisms](#safety-mechanisms)
8. [Monitoring & Analytics](#monitoring--analytics)
9. [Real-World Examples](#real-world-examples)
10. [Best Practices](#best-practices)

## Introduction

This document provides a comprehensive deep-dive into the Kora rent-reclaim bot, explaining the problem it solves, the technology behind it, and how to effectively use it.

### Problem Statement

Kora nodes sponsor Solana transactions for users by paying network fees in SOL while collecting fees in alternative tokens (like USDC, BONK, etc.). When sponsoring account creation, the Kora node must lock SOL as rent to keep the account alive on-chain.

Over time:
- Many accounts become inactive or are closed by users
- Rent-locked SOL becomes inaccessible unless explicitly reclaimed
- Operators often don't track or reclaim these funds
- Silent capital loss accumulates

**The Challenge**: How do operators safely and automatically reclaim this locked rent without manual inspection or risking the closure of active accounts?

### Our Solution

The Kora rent-reclaim bot provides:
- **Automated monitoring** of sponsored accounts
- **Intelligent detection** of closed/eligible accounts
- **Safe reclaim logic** with multiple safety layers
- **Clear audit trails** for every action
- **Optional alerts** via Telegram
- **Reporting** for financial tracking

---

## Understanding Solana Rent

### What is Rent?

On Solana, all data is stored in **accounts**. Each account has a data section (up to 10MB) that can hold arbitrary data. To prevent spam and keep the network efficient, Solana requires accounts to have a minimum balance to remain active. This balance is called **rent**.

### The Rent Formula

The minimum balance (rent) required to keep an account alive is calculated as:

$$\text{MinimumBalance} = (\text{DataSize} + 128) \times \text{RentPerBytePerYear}$$

Where:
- **DataSize**: Size of the account's data in bytes
- **128**: Additional 128 bytes for account metadata
- **RentPerBytePerYear**: Network-wide parameter (~0.35 SOL/byte/year on mainnet as of Jan 2025)

### Rent Exemption

If an account holds at least the **minimum balance**, it is "rent-exempt" and never charged fees. The balance sits idle in the account indefinitely.

### Example Calculations

**Token Account (165 bytes)**
```
MinBalance = (165 + 128) × 0.35 SOL/year ÷ 12 months
           ≈ 293 bytes × 0.029 SOL/byte/month
           ≈ 2.05 SOL
```

**Mint Account (82 bytes)**
```
MinBalance = (82 + 128) × 0.35 SOL/year ÷ 12 months
           ≈ 210 bytes × 0.029 SOL/byte/month
           ≈ 1.14 SOL
```

**Program Data Account (variable)**
```
For 10KB account:
MinBalance = (10240 + 128) × 0.35 ÷ 12
           ≈ 297 SOL
```

### Key Insight

If an account:
1. Is empty (no data)
2. Has no tokens or programs using it
3. Was created by an operator

**Then its entire balance is rent and can be reclaimed by closing the account.**

---

## How Kora Sponsorship Works

### The Kora Transaction Flow

```
Step 1: User Initiates
  └─ User wants to swap tokens or interact with a dApp
  └─ User only has token (e.g., USDC), not SOL

Step 2: App Builds Transaction
  └─ App creates a Solana transaction
  └─ Includes instructions: token swap, create account, etc.
  └─ Adds instruction: Send X tokens to Kora operator
  └─ User signs with their keypair

Step 3: Submit to Kora
  └─ App sends user-signed tx to Kora RPC endpoint
  └─ Kora verifies the transaction against configured rules
  └─ Kora checks: allowed programs? safe tokens? price acceptable?

Step 4: Kora Validates & Signs
  └─ If valid, Kora co-signs as the fee payer
  └─ Kora uses its keypair to sign
  └─ Kora returns fully-signed transaction to app

Step 5: Submit to Solana
  └─ App sends Kora-signed tx to Solana network
  └─ Solana processes:
     ├─ Fee paid in SOL by Kora (from fee payer account)
     ├─ Tokens sent from user to Kora as payment
     └─ Transaction effects (swaps, account creation, etc.)

Step 6: Result
  └─ User completed transaction with only tokens
  └─ Kora keeps tokens as fee
  └─ Kora paid SOL for the network fee
  └─ If account was created: Kora locked rent as SOL
```

### Account Creation During Sponsorship

When the transaction includes account creation (e.g., creating a token account):

```
Transaction Instructions:
  1. Create Account
     └─ CreateAccount instruction creates a new account
     └─ Specifies data size (e.g., 165 bytes for token account)
     └─ Specifies owner (e.g., TokenProgram)
  
  2. Initialize Account
     └─ Token program initializes the data
  
  3. Any other instructions
     └─ Token swaps, transfers, etc.
  
  4. Transfer tokens to Kora
     └─ User's tokens sent to Kora operator as payment

Fee Payer: Kora's keypair
  └─ Signs the transaction
  └─ Pays SOL network fees (~5,000 lamports typical)
  └─ **Also funds the new account's rent**
```

### Key Point: Who Pays Rent?

The fee payer (Kora) must provide the initial lamports for the new account, which includes:
- The rent amount
- The transaction fee (5,000 lamports)

This SOL comes from Kora's fund and sits idle in the newly created account as rent.

---

## The Rent-Locking Problem

### Real-World Scenario

**Operator**: Handles 10,000 transactions per day
**Average**: 30% of txs create a new token account
**New Accounts Daily**: 3,000 accounts
**Rent per Token Account**: ~2.05 SOL
**Daily Rent Locked**: ~6,150 SOL per day

**After 1 Year**:
- Accounts created: ~1 million
- Rent locked: ~2+ million SOL
- Cost: Potential $200M+ in locked capital

### Where Does the Rent Go?

1. **Active Accounts**: Still in use by users → rent is justified
2. **Closed Accounts**: Users closed them → rent can be reclaimed
3. **Orphaned Accounts**: Never used after creation → potential waste
4. **Inactive Accounts**: Not touched in months → possible recovery

### The Operational Gap

Most Kora operators do not:
- Track which accounts they created
- Monitor account status over time
- Know which accounts are closed
- Actively reclaim rent from eligible accounts
- Have visibility into total rent locked

**Result**: Silent capital loss, missed revenue recovery

---

## Our Solution Architecture

### High-Level Design

```
┌─────────────────────────────────────────────┐
│       Kora Rent-Reclaim Bot                 │
├─────────────────────────────────────────────┤
│                                             │
│  ┌──────────────┐  ┌──────────────────┐   │
│  │ CLI Commands │  │ Monitoring Loop  │   │
│  │ (on-demand)  │  │ (background svc) │   │
│  └──────┬───────┘  └────────┬─────────┘   │
│         │                    │             │
│         └────────────┬───────┘             │
│                      │                     │
│         ┌────────────▼─────────────┐       │
│         │   Core Logic            │       │
│         │                          │       │
│         │ • Account Discovery     │       │
│         │ • Rent Analysis         │       │
│         │ • Safety Validation     │       │
│         │ • Reclaim Execution     │       │
│         └────────────┬─────────────┘       │
│                      │                     │
│         ┌────────────▼─────────────┐       │
│         │   Output & Alerts       │       │
│         │                          │       │
│         │ • Structured Logging    │       │
│         │ • Telegram Notifications│       │
│         │ • Report Generation     │       │
│         └────────────┬─────────────┘       │
│                      │                     │
│                      ▼                     │
└─────────────────────────────────────────────┘
                       │
                       ▼
              Solana RPC Endpoint
              (devnet/testnet/mainnet)
```

### Module Breakdown

**1. Account Scanner** (`AccountScanner`)
- Loads account list from file or discovers programmatically
- Verifies accounts exist on-chain
- Provides caching for performance

**2. Rent Calculator** (`RentCalculator`)
- Queries Solana for account info
- Calculates minimum balance required
- Determines if account is rent-exempt
- Identifies reclaimable rent amount

**3. Safety Validator** (`SafetyValidator`)
- Checks whitelist/blacklist
- Enforces minimum account age
- Validates batch size limits
- Provides comprehensive validation report

**4. Reclaim Handler** (`ReclaimHandler`)
- Builds close account transactions
- Handles dry-run mode for testing
- Executes reclaim operations
- Tracks success/failure for each account

**5. Solana Provider** (`SolanaProvider`)
- Wrapper around Solana web3.js
- Manages keypair and connection
- Handles account queries
- Submits transactions to network

**6. Alerts & Reporting** (`TelegramAlerts`, `SessionReporter`)
- Sends Telegram notifications (optional)
- Generates JSON/CSV/HTML reports
- Tracks metrics for monitoring

---

## Technical Implementation

### Account Closing Logic

To reclaim rent, we must close the account. Solana allows account closure under specific conditions:

```typescript
// Prerequisites:
// 1. Account has no data (data.length === 0)
// 2. Account has no tokens (for token accounts)
// 3. Account is not rent-exempt
// 4. Signature from authorized party

// Closure Process:
// - Send SystemProgram.transfer to drain remaining lamports
// - Recipient is the operator's treasury
// - After instruction, account is considered closed
```

### Transaction Example

```typescript
// Close account instruction
const closeInstruction = SystemProgram.transfer({
  fromPubkey: accountToClose,     // Source account
  toPubkey: recipientAddress,     // Operator treasury
  lamports: accountLamports        // All rent lamports
});

// Build transaction
const transaction = new Transaction().add(closeInstruction);
transaction.feePayer = operatorKeypair.publicKey;
transaction.recentBlockhash = latestBlockhash;

// Sign and send
const signature = await sendAndConfirmTransaction(
  connection,
  transaction,
  [operatorKeypair]
);
```

### Batch Processing Strategy

For efficiency with many accounts:

```typescript
async function reclaimBatch(accounts: Account[]): Promise<Result[]> {
  const maxPerBatch = 10; // Configurable
  const results = [];

  for (let i = 0; i < accounts.length; i += maxPerBatch) {
    const batch = accounts.slice(i, i + maxPerBatch);

    for (const account of batch) {
      const result = await reclaimFromAccount(account);
      results.push(result);
    }

    // Rate limiting: wait before next batch
    if (i + maxPerBatch < accounts.length) {
      await sleep(1000); // 1 second between batches
    }
  }

  return results;
}
```

### Monitoring Loop

The bot runs on a configurable cron schedule:

```typescript
// Every N minutes, execute:
async function runMonitoringSession() {
  1. Load account list
  2. Analyze each account's rent status
  3. Filter for eligible reclaims
  4. Validate against safety policies
  5. Execute batch reclaim (if autoReclaim=true)
  6. Report results
  7. Send alerts (if enabled)
  8. Log session details
}

// Scheduled with node-cron:
// "*/5 * * * *" = every 5 minutes
```

---

## Safety Mechanisms

### Layer 1: Whitelist/Blacklist

```json
{
  "safety": {
    "whitelistMode": false,
    "whitelist": ["critical_account_keep_active"],
    "blacklist": ["exploit_attempt_account"]
  }
}
```

- **Whitelist Mode**: Only reclaim from explicitly approved accounts
- **Blacklist**: Prevent reclaim from sensitive accounts

### Layer 2: Minimum Account Age

```json
{
  "safety": {
    "minAccountAge": 30
  }
}
```

Accounts must exist for at least 30 days before reclaim. This prevents:
- Accidentally reclaiming accounts still being set up
- Reclaiming accounts from transactions that might rollback/fail

### Layer 3: Dry-Run Mode

Test all operations without executing:

```bash
DRY_RUN=true npm run reclaim
```

Output shows what *would* happen:
```
[DRY_RUN] Would reclaim 2.05 SOL from account A...
[DRY_RUN] Would reclaim 0.50 SOL from account B...
[DRY_RUN] Total (if executed): 2.55 SOL
```

### Layer 4: Manual Approval

For high-security deployments:

```bash
npm run reclaim --accounts EPjF... 9B5X...
# Requires manual --approve flag
```

### Layer 5: Data Validation

Before reclaim, verify:

```typescript
// Must be true:
✓ Account exists on-chain
✓ Account has no data (data.length === 0)
✓ Account is not rent-exempt
✓ Account is not in blacklist
✓ Account age ≥ minAccountAge
✓ Rent amount ≥ minRentToReclaim threshold
```

### Layer 6: Transaction Verification

Each reclaim transaction includes:

```typescript
// Verification checks:
✓ Properly signed by fee payer
✓ Recent blockhash (max 150 blocks old)
✓ Confirmed on-chain with proper status
✓ Lamports correctly returned to recipient
```

---

## Monitoring & Analytics

### Key Metrics

```json
{
  "timestamp": "2025-01-16T10:05:25Z",
  "operatorName": "My Kora Operator",
  "accountsMonitored": 42,
  "accountsClosed": 3,
  "accountsEligibleForReclaim": 2,
  "reclaimsAttempted": 2,
  "reclaimsSucceeded": 2,
  "reclaimsFailed": 0,
  "totalRentLocked": 12.50,
  "totalRentReclaimed": 4.52,
  "successRate": "100%",
  "executionTimeMs": 8234,
  "nextScheduledRun": "2025-01-16T10:10:25Z"
}
```

### Tracking Rent Over Time

By running periodically and logging results, operators can:

1. **Understand Rent Lifecycle**
   - When rent accumulates
   - Which programs/tokens drive account creation
   - Correlation with transaction volume

2. **ROI Analysis**
   - Revenue from tokens collected
   - Cost of rent locked
   - Net profit/loss from sponsorship

3. **Optimize Strategy**
   - Adjust fees to account for rent costs
   - Limit high-rent account creation
   - Prioritize reclaim of largest accounts

### Example Dashboard Query

```javascript
// SQL: Calculate rent reclaim ROI
SELECT
  DATE(created_at) as date,
  COUNT(*) as accounts_created,
  SUM(rent_amount) as rent_locked,
  SUM(reclaimed_amount) as rent_recovered,
  SUM(tokens_collected) as fees_earned,
  SUM(tokens_collected) - SUM(rent_amount) as net_profit
FROM kora_accounts
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

---

## Real-World Examples

### Example 1: Token Airdrop Bot

**Scenario**: Bot creates token accounts for airdrop recipients

```
Day 1: Create 1,000 token accounts
  └─ 1,000 × 2.05 SOL rent = 2,050 SOL locked

Week 1: Recipients claim tokens, accounts become empty
  └─ Bot runs reclaim check
  └─ 950 accounts closed and empty
  └─ 950 × 2.05 SOL = 1,947 SOL recoverable

Week 2: Bot auto-reclaims batch
  └─ Sends reclaim transactions for 950 accounts
  └─ Recovers 1,947 SOL - 0.05 SOL (txn fees) = 1,942 SOL
  └─ Profit: 1,942 SOL recovered
```

### Example 2: NFT Trading Platform

**Scenario**: Platform creates temporary token accounts for trades

```
Monthly Stats:
  - Transactions: 10,000
  - Temp accounts created: 12,000 (1.2 per tx)
  - Rent locked: 24,600 SOL
  - Active accounts (still in use): 8,000
  - Closed accounts (eligible): 4,000
  - Potential recovery: 8,200 SOL

Monitoring Bot Results (monthly):
  - Reclaimed: 7,850 SOL (95% of eligible)
  - Failed: 350 SOL (reasons: still in use, data corruption)
  - Capital efficiency: 7,850 / 24,600 = 31.9% reclaimed
```

### Example 3: Gaming Guild (Worst Case)

**Scenario**: Game sponsor creates accounts for all new players

```
Annual Stats:
  - Players onboarded: 100,000
  - Accounts created per player: 3
  - Total accounts: 300,000
  - Rent locked: 600,000+ SOL
  - Player retention: 20% (80% inactive)
  - Eligible for reclaim: 240,000 accounts

WITHOUT Bot:
  - Rent lost: 480,000+ SOL annually
  - No tracking, no recovery

WITH Bot:
  - Auto-reclaims closed/inactive accounts
  - Quarterly recovery: 120,000 SOL
  - Annual recovery: 480,000 SOL
  - ROI: Infinite (recovered all locked rent)
```

---

## Best Practices

### 1. Start Conservative

```json
{
  "safety": {
    "dryRun": true,
    "minAccountAge": 90,
    "whitelistMode": true,
    "whitelist": ["high_confidence_accounts"]
  }
}
```

- Use dry-run mode first
- Require manual approval initially
- Use long minimum age
- Start with whitelist of known accounts

### 2. Monitor First Week

Run the bot for 1-2 weeks in monitoring-only mode:

```bash
DRY_RUN=true npm run monitor
# Just collect logs, no actual reclaims
```

Review logs to understand:
- Account discovery patterns
- Rent calculations
- What would be reclaimed

### 3. Gradual Rollout

```
Week 1: Dry-run monitoring only
Week 2: Check specific accounts manually
Week 3: Enable auto-reclaim for selected accounts
Week 4: Full auto-reclaim enabled
```

### 4. Continuous Monitoring

Set up alerts for:
- Large idle rent accumulation
- Unexpected reclaim failures
- Bot crashes or missing runs

```json
{
  "alerts": {
    "thresholds": {
      "largeIdleRent": 1000.0,
      "reclaimFailure": true
    }
  }
}
```

### 5. Regular Audits

Weekly review:

```bash
npm run report --format html --from-date 2025-01-10
```

Check:
- Total rent locked vs. recovered
- Success rate
- Failed accounts (investigate why)
- Trend over time

### 6. Backup & Recovery

Maintain records:

```bash
# Daily backup of accounts list
cp accounts.json "backups/accounts_$(date +%Y%m%d).json"

# Archive logs monthly
tar -czf "logs_$(date +%Y%m).tar.gz" logs/
```

### 7. Update Account Lists

Periodically refresh accounts:

```bash
# Add newly discovered accounts
npm run check:accounts --file new-accounts.json

# Merge with existing list
cat accounts.json new-accounts.json | jq -s 'unique_by(.address)' > merged.json
```

### 8. Test Edge Cases

Before production, test:

- Account with data (cannot close)
- Rent-exempt account (nothing to reclaim)
- Very old account (edge case timing)
- Account with partial rent (verify math)
- Insufficient fee payer balance
- RPC endpoint failures

---

## Troubleshooting Guide

### Issue: "Account not found"

**Cause**: Account address is invalid or doesn't exist

**Solution**:
```bash
# Verify account on Solscan
https://solscan.io/account/<ACCOUNT_ADDRESS>

# Check RPC endpoint
curl https://api.devnet.solana.com -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["<ADDRESS>"]}'
```

### Issue: "Insufficient lamports"

**Cause**: Fee payer (operator) doesn't have enough SOL

**Solution**:
```bash
# Check balance
npm run balance

# Fund the operator keypair
solana transfer <OPERATOR_ADDRESS> 1.0 --from <YOUR_KEYPAIR>
```

### Issue: "Cannot close account with data"

**Cause**: Account is not empty (still has data or tokens)

**Solution**:
```typescript
// Before closing, must:
// 1. Empty any token accounts
// 2. Withdraw all SOL except minimum
// 3. Close child accounts first

// Or, configure to skip:
"safety": {
  "blacklist": ["account_with_data"]
}
```

### Issue: "Transaction failed: Block hash not found"

**Cause**: Blockhash is too old (>150 blocks)

**Solution**:
- Retry the transaction
- Network latency issue - use faster RPC
- Check network congestion

---

## Conclusion

The Kora rent-reclaim bot automates the critical task of recovering locked rent from sponsored accounts. By combining:

1. **Intelligent account discovery and analysis**
2. **Multiple layers of safety validation**
3. **Automated reclaim execution**
4. **Comprehensive monitoring and alerts**

Operators can recover lost capital, improve profitability, and maintain operational visibility.

Start small, test thoroughly, and gradually expand as you gain confidence. Always maintain backups and monitor continuously.

For updates, issues, or contributions, see the GitHub repository.

---

## Appendix: Formulas & References

### Rent Calculation Formula

$$R = \frac{(\text{DataSize} + 128) \times \text{YearlyRate}}{12}$$

Where YearlyRate ≈ 0.35 SOL/byte/year (mainnet, Jan 2025)

### Account Age Calculation

$$\text{AgeDays} = \frac{\text{Now} - \text{CreationTime}}{86400000 \text{ ms/day}}$$

### Success Rate Calculation

$$\text{SuccessRate} = \frac{\text{SuccessfulReclaims}}{\text{AttemptedReclaims}} \times 100\%$$

### Capital Efficiency

$$\text{ROI} = \frac{\text{TotalReclaimed}}{\text{TotalLocked}} \times 100\%$$

---

**Document Version**: 1.0.0  
**Last Updated**: January 16, 2025  
**Status**: Complete
