# Kora Rent Reclaim Bot

> **Recover locked SOL from Kora-sponsored accounts**

A Kora operator installs this tool and finally understands:
- 💰 How much SOL is silently locked
- 📍 Where it is locked  
- 💀 Which accounts are dead
- ♻️ And gets their SOL back safely

---

## 🎯 The Problem This Solves

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
│   YOUR OPERATOR WALLET  ◄────────────────────────────────────┐  │
│      │                                                       │  │
│      │ 3. Signs as FEE PAYER                                 │  │
│      │    - Pays transaction fee (~0.000005 SOL)             │  │
│      │    - Pays RENT for new accounts (0.002+ SOL each) ────┘  │
│      ▼                                                          │
│   New Accounts Created                                          │
│      │                                                          │
│      │ • Associated Token Accounts (ATAs)                       │
│      │ • Program Derived Addresses (PDAs)                       │
│      │ • System accounts                                        │
│      ▼                                                          │
│   YOUR SOL IS NOW LOCKED  ◄─── This is the problem!             │
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

## 🔧 How This Bot Helps

### The Solution

This bot:
1. **Discovers** accounts YOUR operator sponsored (via transaction history)
2. **Tracks** them in a persistent registry
3. **Monitors** their status (active, empty, closed)
4. **Identifies** which are safe to reclaim
5. **Reclaims** locked rent back to your treasury
6. **Reports** exactly what happened and why

### The Result

```
$ kora-rent-bot scan

═══════════════════════════════════════════════════════════════
             SPONSORED ACCOUNT SCAN RESULTS
═══════════════════════════════════════════════════════════════

📊 Account Summary:
   Total sponsored accounts: 1,247
   🟢 Active (do not touch): 891
   ⚪ Closed / reclaimed:    312
   🔴 Empty / reclaimable:   44

💰 SOL Summary:
   Total rent locked:   152.34 SOL
   ♻️  Reclaimable now:   37.81 SOL
```

---

## 📦 Installation

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

## 🚀 Usage

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
📊 Account Summary:
   Total sponsored accounts: 1,247
   🟢 Active (do not touch): 891
   ⚪ Closed / reclaimed:    312
   🔴 Empty / reclaimable:   44

💰 SOL Summary:
   Total rent locked:   152.34 SOL
   ♻️  Reclaimable now:   37.81 SOL

──────────────────────────────────────────────────────────────
🔴 Reclaimable Accounts (44):

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
   🚀 EXECUTING RECLAIMS
═══════════════════════════════════════════════════════════════

   ✓ 5Ce2vQd...
      Type: token
      Value: 0.002039 SOL
      Risk: safe
      ✅ Tx: 5Kj3nMv...
      ✅ Verified: true

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

## 🛡️ Safety Guarantees

This bot is **defensive by design**. It will **NEVER**:

| Rule | Protection |
|------|------------|
| ❌ Reclaim active accounts | Only touches accounts with zero balance/empty data |
| ❌ Reclaim recent accounts | Minimum 7-day inactivity threshold |
| ❌ Reclaim accounts with recent activity | Checks for writes in last 3 days |
| ❌ Reclaim accounts you don't own | Verifies ownership before close |
| ❌ Reclaim high-value accounts without review | Flags accounts > 0.1 SOL |
| ❌ Touch PDA accounts | PDAs require manual review |
| ❌ Touch deny-listed accounts | Configurable deny list |

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

## ⚙️ Configuration

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

## 📊 Commands Reference

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

## 📁 Data Files

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

## 🤔 FAQ

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

## 📜 License

MIT

---

## 🙏 Contributing

PRs welcome! Please ensure:
- All safety checks remain in place
- Dry-run mode works correctly
- Documentation is updated
