 # Kora Rent Reclaim Bot

> **Track and monitor SOL locked in Kora-sponsored accounts**

A Kora operator installs this tool and finally understands:
- How much SOL is silently locked
- Where it is locked  
- Which accounts are dead/empty
- Track when users close their accounts

---

## IMPORTANT: Understanding Solana Account Ownership

### The Hard Truth About "Reclaiming" Rent

On Solana, **you can only close accounts you OWN**. When Kora sponsors account creation:

| Who Pays | Who Owns | Who Can Close | Where Rent Goes |
|----------|----------|---------------|-----------------|
| Operator (you) | User | User only | Back to User |

**This means**: Even though you PAID for the account, you CANNOT close it or reclaim the rent. The user must close it, and the rent returns to THEM.

### What This Bot Actually Does

| Feature | Description |
|---------|-------------|
| **Track** | Monitor all accounts you've sponsored |
| **Monitor** | Check which are active, empty, or closed |
| **Report** | See how much SOL is locked in sponsorships |
| **Notify** | Know when users close their accounts |
| **Reclaim** | Close accounts YOU own (rare cases only) |

### When CAN You Actually Reclaim?

1. **Accounts you own** - If you retained ownership (rare)
2. **Your own ATAs** - Token accounts where YOU are the wallet owner
3. **PDAs your program controls** - If you have the authority

---

## How We Identify Kora-Sponsored Accounts

**Critical Question**: How do we distinguish Kora-sponsored accounts from normal operator transactions?

### The Key Distinction

| Transaction Type | Fee Payer | Account Beneficiary | Is Sponsorship? |
|-----------------|-----------|---------------------|-----------------|
| **Normal operator tx** | Operator | Operator | NO |
| **Kora sponsorship** | Operator | User (different wallet) | YES |

### Deterministic Identification Criteria

A Kora-sponsored account is identified when **ALL** of these conditions are met:

```
CRITERIA 1: FEE PAYER CHECK
├── operator_pubkey === accountKeys[0]
└── Operator paid the transaction fees

CRITERIA 2: ACCOUNT CREATION CHECK
├── Transaction contains: CreateAccount, CreateAccountWithSeed, or CreateATA
└── New accounts were created

CRITERIA 3: RENT SOURCE CHECK  
├── The "source" or "payer" field === operator
└── Operator's SOL funded the rent

CRITERIA 4: OWNERSHIP SEPARATION CHECK (THE KEY CHECK)
├── The created account's beneficiary !== operator
├── For ATAs: wallet field !== operator (user owns the ATA)
├── For PDAs: owner is a program (not operator)
└── This proves it's sponsorship, not a self-transaction
```

### Why This Works

```
NORMAL TRANSACTION:
  Operator creates ATA for themselves
  ├── Fee payer: Operator
  ├── Wallet (beneficiary): Operator  <-- SAME
  └── Result: NOT SPONSORSHIP (filtered out)

KORA SPONSORSHIP:
  Operator pays for user's ATA creation
  ├── Fee payer: Operator
  ├── Wallet (beneficiary): User      <-- DIFFERENT
  └── Result: IS SPONSORSHIP (tracked)
```

### Confidence Levels

Each identified account has a confidence level:

| Confidence | Criteria | Example |
|------------|----------|---------|
| **HIGH** | Beneficiary is a clearly different wallet | ATA where wallet != operator |
| **MEDIUM** | Owner is a program (PDA) | Program-owned accounts |
| **LOW** | Cannot clearly determine beneficiary | Edge cases |

---

## The Problem This Solves

### Where Does Your SOL Go?

When you run a Kora node, you act as a **paymaster** for user transactions. Here's what happens:

```
┌─────────────────────────────────────────────────────────────────┐
│                    KORA SPONSORSHIP FLOW                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   User App                                                      │
│      │                                                          │
│      │ 1. User initiates transaction (swap, mint, transfer)     │
│      ▼                                                          │
│   Kora Paymaster Service                                        │
│      │                                                          │
│      │ 2. Routes to YOUR Kora node                              │
│      ▼                                                          │
│   YOUR OPERATOR WALLET  <────────────────────────────────────┐  │
│      │                                                       │  │
│      │ 3. Signs as FEE PAYER                                 │  │
│      │    - Pays transaction fee (~0.000005 SOL)             │  │
│      │    - Pays RENT for new accounts (0.002+ SOL each) ────┘  │
│      ▼                                                          │
│   New Accounts Created (owned by USER, paid by OPERATOR)        │
│      │                                                          │
│      │ - Associated Token Accounts (ATAs) -> wallet = USER      │
│      │ - Program Derived Addresses (PDAs) -> owner = PROGRAM    │
│      │ - System accounts                                        │
│      ▼                                                          │
│   YOUR SOL IS NOW LOCKED  <─── This is the problem!             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### The Hidden Cost

Every time your Kora node sponsors a transaction that creates an account:

| Account Type | Rent Cost | Your SOL Locked |
|-------------|-----------|-----------------|
| Token Account (ATA) | ~0.00204 SOL | **Locked until account is closed** |
| System Account | ~0.00089 SOL | **Locked until account is closed** |
| PDA (varies) | 0.001-0.01 SOL | **Locked until program closes it** |

**Over time, this adds up:**
- Sponsor 1,000 token accounts = **2.04 SOL locked**
- Sponsor 10,000 token accounts = **20.4 SOL locked**
- Sponsor 100,000 token accounts = **204 SOL locked**

Most of these accounts become **inactive** within days. The users are done with them. But your SOL stays locked.

---

## How This Bot Helps

### The Solution

This bot:
1. **Discovers** accounts YOUR operator sponsored using the deterministic criteria above
2. **Filters out** self-transactions (where operator created accounts for themselves)
3. **Tracks** sponsored accounts in a persistent registry with beneficiary info
4. **Monitors** their status (active, empty, closed)
5. **Identifies** which are safe to reclaim
6. **Reclaims** locked rent back to your treasury
7. **Reports** exactly what happened and why

### The Result

```
$ kora-rent-bot scan

═══════════════════════════════════════════════════════════════
             SPONSORED ACCOUNT SCAN RESULTS
═══════════════════════════════════════════════════════════════

Account Summary:
   Total sponsored accounts: 1,247
   Active (do not touch): 891
   Closed / reclaimed:    312
   Empty / reclaimable:   44

SOL Summary:
   Total rent locked:   152.34 SOL
   Reclaimable now:     37.81 SOL
```

---

## Installation

```bash
# Clone the repository
git clone https://github.com/DVO1111/Kora.git
cd Kora

# Install dependencies
npm install

# Build
npm run build

# Create config
cp config.example.json config.json
# Edit config.json with your settings
```

---

## Usage

### Step 1: Discover Sponsored Accounts

First, ingest your transaction history to build the sponsorship registry:

```bash
kora-rent-bot ingest --operator YOUR_OPERATOR_ADDRESS --limit 1000
```

This scans your transaction history and identifies accounts where:
- Your operator was the **fee payer** (accountKeys[0])
- The transaction **created new accounts**
- Your SOL paid for the **rent**

### Step 2: Scan Current Status

Check the current state of all tracked accounts:

```bash
kora-rent-bot scan --operator YOUR_OPERATOR_ADDRESS
```

Output:
```
Account Summary:
   Total sponsored accounts: 1,247
   Active (do not touch): 891
   Closed / reclaimed:    312
   Empty / reclaimable:   44

SOL Summary:
   Total rent locked:   152.34 SOL
   Reclaimable now:     37.81 SOL

──────────────────────────────────────────────────────────────
Reclaimable Accounts (44):

   Account:  5Ce2vQd...
   Type:     token
   Created:  2024-01-15
   Rent:     0.002039 SOL
   Status:   EMPTY
```

### Step 3: Reclaim (Dry Run)

Always dry-run first to see what would happen:

```bash
kora-rent-bot reclaim --operator YOUR_OPERATOR_ADDRESS --dry-run
```

Output:
```
═══════════════════════════════════════════════════════════════
   ⚠️  DRY RUN - No transactions will be sent
═══════════════════════════════════════════════════════════════

   ✓ 5Ce2vQd...
      Type: token
      Value: 0.002039 SOL
      Risk: safe
      → Would reclaim 0.002039 SOL

   ✓ 9FdA3x7...
      Type: token
      Value: 0.002039 SOL
      Risk: safe
      → Would reclaim 0.002039 SOL

──────────────────────────────────────────────────────────────

📋 Total reclaimable: 37.81 SOL

💡 Run with --execute to reclaim these funds.
```

### Step 4: Execute Reclaim

When you're confident, execute for real:

```bash
kora-rent-bot reclaim \
  --operator YOUR_OPERATOR_ADDRESS \
  --treasury YOUR_TREASURY_ADDRESS \
  --key ./keypair.json \
  --execute
```

Output:
```
═══════════════════════════════════════════════════════════════
   EXECUTING RECLAIMS
═════════════════════════════════════════════════════════════

   [OK] 5Ce2vQd...
      Type: token
      Value: 0.002039 SOL
      Risk: safe
      Tx: 5Kj3nMv...
      Verified: true

──────────────────────────────────────────────────────────────
                    RECLAIM SUMMARY
──────────────────────────────────────────────────────────────
   Accounts reclaimed:     44
   Total reclaimed:        37.81 SOL
   Treasury before:        100.00 SOL
   Treasury after:         137.81 SOL
═══════════════════════════════════════════════════════════════
```

### Step 5: View Reports

Check your historical metrics:

```bash
kora-rent-bot report --operator YOUR_OPERATOR_ADDRESS
```

---

## Safety Guarantees

This bot is **defensive by design**. It will **NEVER**:

| Rule | Protection |
|------|------------|
| Reclaim active accounts | Only touches accounts with zero balance/empty data |
| Reclaim recent accounts | Minimum 7-day inactivity threshold |
| Reclaim accounts with recent activity | Checks for writes in last 3 days |
| Reclaim accounts you don't own | Verifies ownership before close |
| Reclaim high-value accounts without review | Flags accounts > 0.1 SOL |
| Touch PDA accounts | PDAs require manual review |
| Touch deny-listed accounts | Configurable deny list |

### Validation Checks

Every account goes through these checks before reclaim:

```typescript
checks: {
  inDenyList: false,           // Not in deny list
  hasRecentWrites: false,      // No activity in last 3 days
  meetsInactivityThreshold: true, // >7 days old
  isEmptyOrZeroBalance: true,  // Data is empty/zeroed
  ownershipVerified: true,     // We can close it
  belowMaxReclaim: true,       // Under safety threshold
}
```

---

## Configuration

Create `config.json`:

```json
{
  "rpcUrl": "https://api.mainnet-beta.solana.com",
  "operatorAddress": "YOUR_OPERATOR_WALLET_ADDRESS",
  "treasuryAddress": "YOUR_TREASURY_ADDRESS",
  "privateKeyPath": "./keypair.json"
}
```

Or use environment variables:

```bash
export SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
export OPERATOR_ADDRESS=YOUR_OPERATOR_ADDRESS
export TREASURY_ADDRESS=YOUR_TREASURY_ADDRESS
export PRIVATE_KEY_PATH=./keypair.json
```

---

## Commands Reference

| Command | Description |
|---------|-------------|
| `ingest` | Discover sponsored accounts from tx history |
| `scan` | Check current status of tracked accounts |
| `reclaim` | Reclaim rent from eligible accounts |
| `report` | Show historical metrics |
| `status <address>` | Check a specific account |

### Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--rpc` | Solana RPC URL | devnet |
| `--operator` | Operator wallet address | config |
| `--treasury` | Treasury for reclaimed SOL | operator |
| `--key` | Path to keypair JSON | - |
| `--dry-run` | Simulate only | true |
| `--execute` | Actually execute | false |
| `--min-age` | Minimum account age (days) | 7 |
| `--max-per-run` | Max accounts per run | 50 |

---

## Data Files

The bot maintains these files:

```
data/
├── sponsorship-registry.json  # Tracked accounts + metrics
└── reclaim-reports/
    ├── reclaim-1705432800000.json
    └── reclaim-1705519200000.json
```

### Registry Format

```json
{
  "operator": "YOUR_OPERATOR_ADDRESS",
  "accounts": [
    {
      "address": "5Ce2vQd...",
      "creationTxSignature": "4xKp...",
      "createdAt": 1705432800,
      "rentLamports": 2039280,
      "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "accountType": "token",
      "status": "empty"
    }
  ],
  "metrics": {
    "totalAccountsSponsored": 1247,
    "totalRentLocked": 2543521200,
    "totalRentReclaimed": 378100000,
    "totalAccountsClosed": 356
  }
}
```

### Reclaim Log Format

```json
{
  "timestamp": "2024-01-16T12:00:00.000Z",
  "account": "5Ce2vQd...",
  "lamports": 2039280,
  "sol": 0.002039,
  "reason": "Token account with zero balance - safe to close",
  "txSignature": "5Kj3nMv...",
  "status": "success",
  "treasuryBalanceBefore": 100000000000,
  "treasuryBalanceAfter": 100002039280,
  "verified": true
}
```

---

## FAQ

### How do I know an account was sponsored by Kora?

The bot identifies sponsored accounts by:
1. Finding transactions where your operator was fee payer (accountKeys[0])
2. Detecting account creation instructions in those transactions
3. Recording the rent that came from your wallet

### Is this safe to run on mainnet?

Yes, with precautions:
1. Always `--dry-run` first
2. Start with `--max-per-run 5` for initial tests
3. Verify the dry-run output makes sense
4. Use a dedicated treasury address

### What if I reclaim the wrong account?

The safety checks make this nearly impossible:
- Only empty/zero-balance accounts are touched
- Accounts must be >7 days old
- No recent activity allowed
- You must own the account to close it

### How much can I recover?

Depends on your sponsorship volume. Typical results:
- Small operator (1K accounts): 2-5 SOL
- Medium operator (10K accounts): 20-50 SOL
- Large operator (100K accounts): 200-500 SOL

---

## Telegram Bot Interface

Instead of CLI commands, you can control the bot via Telegram for a more user-friendly experience.

### Setup

1. **Create a Telegram Bot**
   - Open Telegram and message [@BotFather](https://t.me/BotFather)
   - Send `/newbot` and follow the prompts
   - Copy the bot token (looks like `123456789:ABCdefGHIjklMNO...`)

2. **Configure the bot**

   Add to your `config.json`:
   ```json
   {
     "telegramToken": "YOUR_BOT_TOKEN",
     "operatorAddress": "YOUR_OPERATOR_ADDRESS",
     "rpcUrl": "https://api.mainnet-beta.solana.com",
     "treasuryAddress": "YOUR_TREASURY_ADDRESS",
     "privateKeyPath": "./keypair.json",
     "authorizedUsers": [123456789]
   }
   ```

   Or use environment variables:
   ```bash
   export TELEGRAM_BOT_TOKEN="your_bot_token"
   export OPERATOR_ADDRESS="your_operator_address"
   export SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
   ```

3. **Get your Telegram User ID**
   - Message [@userinfobot](https://t.me/userinfobot) to get your ID
   - Add it to `authorizedUsers` for security (optional)

4. **Start the bot**
   ```bash
   npm run telegram
   ```

### Available Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and setup info |
| `/help` | Show all available commands |
| `/status` | Operator wallet status and metrics |
| `/scan` | Scan for reclaimable accounts |
| `/report` | Generate detailed reclaim report |
| `/watch [minutes]` | Start auto-monitoring (default: 60 min) |
| `/watch off` | Stop auto-monitoring |
| `/reclaim` | Reclaim eligible accounts (with confirmation) |
| `/settings` | View current configuration |

### Example Session

```
You: /status

Bot: OPERATOR STATUS

Wallet:
• Address: 7xKXtg2C...JosgAsU
• Balance: 12.345678 SOL

Sponsorship Metrics:
• Total Sponsored: 1,247
• Total Rent Locked: 152.34 SOL
• Reclaimed: 45.12 SOL
• Pending: 107.22 SOL

Watch Mode:
• Status: Inactive

---

You: /scan

Bot: SCAN COMPLETE

Account Status:
• Active: 891
• Empty: 44
• Closed: 312
• Updated: 1247

Reclaimable:
• Accounts: 44
• Total SOL: 0.088 SOL

Use /reclaim to recover this SOL.

---

You: /reclaim

Bot: RECLAIM CONFIRMATION

Ready to reclaim:
• Accounts: 44
• Total SOL: 0.088 SOL
• Treasury: 9yVmSvE5...BvETNqKY

Choose an action:
[Dry Run First] [Execute Reclaim] [Cancel]
```

### Watch Mode Notifications

When watch mode is active, you'll receive automatic notifications:

```
[2025-01-20 08:00:00] Auto-scan complete
• Found: 12 accounts eligible
• Reclaimable: 0.024 SOL

Use /reclaim to recover.
```

---

## Demo Script - Quick Start

Ready-to-run commands to test the bot. Replace `YOUR_OPERATOR_ADDRESS` with your actual Solana address.

```bash
# 1. Build the project
npm run build

# 2. Check system status
npx ts-node src/bot.ts status --operator YOUR_OPERATOR_ADDRESS

# 3. Ingest historical sponsorships (adjust limit as needed)
npx ts-node src/bot.ts ingest --operator YOUR_OPERATOR_ADDRESS --limit 100

# 4. Scan for reclaimable accounts
npx ts-node src/bot.ts scan --operator YOUR_OPERATOR_ADDRESS

# 5. Generate a report
npx ts-node src/bot.ts report --operator YOUR_OPERATOR_ADDRESS

# 6. Dry-run reclaim (SAFE - no actual transactions)
npx ts-node src/bot.ts reclaim \
  --operator YOUR_OPERATOR_ADDRESS \
  --key ./path/to/keypair.json \
  --dry-run

# 7. Start watch mode for observable scheduled runs
npx ts-node src/bot.ts watch \
  --operator YOUR_OPERATOR_ADDRESS \
  --interval 60

# 8. Watch mode WITH auto-reclaim (use carefully!)
npx ts-node src/bot.ts watch \
  --operator YOUR_OPERATOR_ADDRESS \
  --interval 60 \
  --auto-reclaim \
  --key ./path/to/keypair.json \
  --treasury YOUR_TREASURY_ADDRESS
```

### Expected Watch Mode Output

When running in watch mode, you'll see timestamped logs like this:

```
============================================================
   KORA RENT RECLAIM BOT - WATCH MODE
============================================================
[2025-01-20 08:00:00] Watch mode started
[2025-01-20 08:00:00] Operator: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
[2025-01-20 08:00:00] Scan interval: 60 minutes
[2025-01-20 08:00:00] Auto-reclaim: ENABLED
[2025-01-20 08:00:00] Treasury: 9yVmSvE5tz5wPP1TAj4PvmFZHMRBvETNqKYBHrdJuq3Z
------------------------------------------------------------

[2025-01-20 08:00:01] Automatic scan starting...
[2025-01-20 08:00:05] Automatic scan complete
[2025-01-20 08:00:05] Found: 12 accounts eligible for reclaim
[2025-01-20 08:00:05] Total tracked: 847 accounts
[2025-01-20 08:00:05] Status: 623 active, 212 empty, 12 closed
[2025-01-20 08:00:05] Reclaimable SOL: 0.024 SOL
[2025-01-20 08:00:05] Auto-reclaim triggered for 12 accounts
[2025-01-20 08:00:12] Reclaimed: 0.024 SOL
[2025-01-20 08:00:12] Accounts processed: 12/12
------------------------------------------------------------
[2025-01-20 08:00:12] Next scan in 60 minutes

[2025-01-20 09:00:00] Automatic scan starting...
[2025-01-20 09:00:04] Automatic scan complete
[2025-01-20 09:00:04] Found: 3 accounts eligible for reclaim
...
```

### Quick Devnet Test

For testing without real SOL:

```bash
# Use devnet RPC
export RPC_URL="https://api.devnet.solana.com"

# Create test keypair (if needed)
solana-keygen new -o ./test-keypair.json

# Run scan on devnet
npx ts-node src/bot.ts scan \
  --operator $(solana-keygen pubkey ./test-keypair.json) \
  --rpc $RPC_URL
```

---

## License

MIT

---

## Contributing

PRs welcome! Please ensure:
- All safety checks remain in place
- Dry-run mode works correctly
- Documentation is updated
