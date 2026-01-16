# Kora Rent-Reclaim Bot

An automated bot to monitor and reclaim rent from sponsored accounts created through a Kora node on Solana.

## Overview

This bot helps Kora operators recover locked SOL rent from closed or inactive accounts. When a Kora node sponsors account creation, SOL is locked as rent. Over time, many accounts become inactive or are no longer needed. This bot monitors those accounts and automatically reclaims rent SOL back to the operator's treasury.

## Key Features

- **Account Monitoring**: Tracks all accounts sponsored by your Kora node
- **Rent Status Detection**: Identifies closed, inactive, or eligible accounts
- **Automated Reclaim**: Safely recovers rent SOL to operator treasury
- **Detailed Logging**: Clear audit trail of all operations with explanations
- **Safety Controls**: Whitelists, blacklists, and dry-run modes for safe testing
- **Reporting**: Dashboard-ready metrics and alerts for large idle rent amounts
- **CLI & Service Modes**: Run on-demand or as a continuous background service

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Understanding Kora & Solana Rent](#understanding-kora--solana-rent)
- [Usage](#usage)
- [How It Works](#how-it-works)
- [Safety & Controls](#safety--controls)
- [Monitoring & Reporting](#monitoring--reporting)

## Prerequisites

- Node.js 18+
- Solana CLI (optional, for wallet management)
- A Solana RPC endpoint (devnet, testnet, or mainnet)
- A Kora node operator account or access to operator details
- SOL balance to cover reclaim transaction fees

## Installation

```bash
git clone https://github.com/DVO1111/Kora.git
cd Kora

npm install
npm run build
```

## Configuration

### 1. Environment Variables

Create a `.env` file in the root directory:

```env
# Solana RPC Configuration
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_COMMITMENT=confirmed

# Kora Operator Configuration
OPERATOR_KEYPAIR_PATH=./keys/operator-keypair.json
OPERATOR_TREASURY_ADDRESS=<YOUR_OPERATOR_TREASURY_WALLET>

# Optional: If using Kora node
KORA_NODE_URL=http://localhost:8080

# Bot Configuration
MONITOR_INTERVAL_MINUTES=5
DRY_RUN=false
LOG_LEVEL=info

# Optional: Telegram Bot for Alerts
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Optional: Database for tracking
DATABASE_URL=sqlite:./bot.db
```

### 2. Operator Configuration (config.json)

Create a `config.json` file to define which accounts to monitor:

```json
{
  "operatorName": "My Kora Operator",
  "network": "devnet",
  "rpcUrl": "https://api.devnet.solana.com",
  "treasuryAddress": "<OPERATOR_TREASURY>",
  "monitoring": {
    "enabled": true,
    "intervalMinutes": 5,
    "checkAccountStatus": true,
    "checkRentEligibility": true
  },
  "reclaimPolicy": {
    "enabled": true,
    "autoReclaim": true,
    "minRentToReclaim": 0.002,
    "maxReclaimPerBatch": 10
  },
  "safety": {
    "dryRun": false,
    "requiredApprovals": 0,
    "minAccountAge": 30,
    "whitelistMode": false,
    "whitelist": [],
    "blacklist": []
  },
  "alerts": {
    "enabled": true,
    "thresholds": {
      "largeIdleRent": 1.0,
      "reclaimSuccess": true,
      "reclaimFailure": true
    }
  }
}
```

### 3. Keypair Setup

Place your operator keypair (obtained from `solana-keygen new`) in the path specified by `OPERATOR_KEYPAIR_PATH`:

```bash
solana-keygen new --outfile ./keys/operator-keypair.json
```

## Understanding Kora & Solana Rent

### What is Rent on Solana?

Solana stores all data in accounts. To keep an account alive, a certain amount of SOL must be locked in the account as **rent**. The amount depends on the account's data size:

```
rent = (account_data_size + 128) * rent_per_byte_year
```

On mainnet (Jan 2025), the rent-per-byte-year is approximately 3.5 SOL per year.

**Example**: A typical token account (165 bytes) requires ~2 SOL rent to be exempt.

### How Kora Creates Sponsored Accounts

When Kora sponsors a transaction:

1. User initiates a transaction that creates a new account (e.g., a token account)
2. App signs the transaction with user's keys
3. App sends to Kora node for fee sponsorship
4. **Kora signs as the fee payer** and also covers the initial rent cost
5. Transaction lands on-chain
6. SOL is locked in the account as rent; user never pays

Over time, if the account is:
- **Closed** by the account owner → rent can be reclaimed
- **Inactive** (not used in X days) → operator might choose to reclaim
- **Orphaned** (owner never interacts with) → potential recovery

### Rent Reclaim Mechanism

When an account is closed or no longer needed:

1. **Account must be empty** (no SOL, tokens, or data)
2. **Account authority must sign** the close transaction OR
3. **Anyone can close** if the account is solely rent-bearing (no stored data)

The bot's `reclaimRent()` function:
- Checks if account is empty and has no data
- Sends a transaction to close the account
- Rent SOL returns to the account opener (or transaction fee payer)

## Usage

### CLI Mode (On-Demand)

```bash
# Check all monitored accounts
npm run check:accounts

# Reclaim rent from specific accounts
npm run reclaim -- --accounts <ACCOUNT1> <ACCOUNT2>

# Dry-run (preview what would happen)
npm run reclaim -- --dry-run

# Generate a report
npm run report -- --from-date 2025-01-01 --to-date 2025-01-15
```

### Service Mode (Continuous Monitoring)

```bash
npm run monitor
```

This starts the bot in background service mode, which:
- Polls Solana RPC every N minutes (configurable)
- Checks account status
- Automatically reclaims eligible rent (if enabled)
- Logs all actions
- Sends alerts via Telegram (optional)

### Example: Monitor and Auto-Reclaim

```bash
# Start monitoring with auto-reclaim enabled (set DRY_RUN=false)
npm run monitor

# Logs will show:
# [2025-01-16 10:05:15] Monitoring 42 sponsored accounts...
# [2025-01-16 10:05:17] Account EPjFWdd5Au... is CLOSED. Rent: 2.05 SOL
# [2025-01-16 10:05:18] Reclaiming rent from 2 eligible accounts...
# [2025-01-16 10:05:25] ✓ Reclaim txn: 3hK... (2.05 SOL recovered)
# [2025-01-16 10:05:25] Total reclaimed this session: 4.52 SOL
```

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────┐
│          Kora Rent-Reclaim Bot                  │
├─────────────────────────────────────────────────┤
│                                                 │
│  CLI Interface  │  Cron Service  │  Monitoring │
│    (on-demand)  │  (background)  │   Loop      │
│                                                 │
└────────────────────┬────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          │                     │
    ┌─────▼──────┐      ┌──────▼──────┐
    │  Validator  │      │   Logger    │
    │  (Safety    │      │  (Audit &   │
    │   Checks)   │      │  Reporting) │
    └──────┬──────┘      └─────────────┘
           │
    ┌──────▼──────────────────┐
    │  Solana RPC Provider    │
    │  - Get account info     │
    │  - Check rent status    │
    │  - Send reclaim txns    │
    └────────────────────────┘
```

### Step-by-Step Flow

1. **Discovery**: Load operator's keypair and read config
2. **Scanning**: Query Solana for all accounts where operator is signer/rent payer
3. **Analysis**: For each account:
   - Check if account is closed/empty
   - Calculate rent amount
   - Check against whitelist/blacklist
   - Determine if eligible for reclaim
4. **Validation**: Safety checks before reclaim
5. **Reclaim**: Send close account transaction
6. **Logging**: Record action with timestamp, amount, and status

### Data Flow Example

```
Kora Node (operator) 
    ↓
    └─→ Sponsors token account creation
            ├─ Account: 9B5X... (165 bytes)
            ├─ Rent: 2.05 SOL locked
            ├─ User: Bb7Q...
            └─ Created: 2025-01-10

[Bot runs every 5 minutes]

Check Solana RPC:
    getAccountInfo(9B5X...)
    ├─ owner: TokenkegQfeZyiNwAJsyFbPVwwQkYk5modlYKYro8t
    ├─ executable: false
    ├─ lamports: 2,050,000 (rent)
    ├─ data.length: 0 (empty)
    └─ state: CLOSED

Decision:
    ✓ Is empty? YES
    ✓ Is closed? YES
    ✓ In blacklist? NO
    ✓ Min age > 30 days? YES
    
Action:
    Send close account transaction
    ↓
    Rent 2.05 SOL returned to operator treasury
    ↓
    Log: "Reclaimed 2.05 SOL from account 9B5X..."
```

## Safety & Controls

### Whitelist/Blacklist

```json
"safety": {
  "whitelistMode": false,
  "whitelist": ["account1_to_only_reclaim", "account2_to_only_reclaim"],
  "blacklist": ["critical_account_do_not_touch", "test_account"]
}
```

### Dry-Run Mode

Test without executing transactions:

```bash
DRY_RUN=true npm run reclaim
```

Output shows what *would* happen without actual blockchain changes.

### Minimum Age

Accounts must exist for at least N days before reclaim:

```json
"safety": {
  "minAccountAge": 30
}
```

### Approval Requirements

For high-security setups, require manual approval:

```json
"safety": {
  "requiredApprovals": 1
}
```

## Monitoring & Reporting

### Real-Time Logs

All actions are logged with timestamps:

```
[2025-01-16 10:05:15 INFO] Monitoring 42 sponsored accounts
[2025-01-16 10:05:17 INFO] Account EPjF... closed. Rent: 2.05 SOL
[2025-01-16 10:05:18 WARN] Rent > 1.0 SOL from 3 accounts
[2025-01-16 10:05:25 INFO] Reclaimed 2.05 SOL (txn: 3hK...)
[2025-01-16 10:05:25 INFO] Session summary: 4 accounts checked, 1 reclaimed, 4.52 SOL recovered
```

### Alerts

Telegram bot alerts (optional):

```
🔔 Kora Rent Alert
Account closed: 9B5X...
Rent reclaimed: 2.05 SOL
Total recovered today: 8.30 SOL
```

### Metrics & Dashboards

JSON metrics for external monitoring:

```json
{
  "timestamp": "2025-01-16T10:05:25Z",
  "accountsMonitored": 42,
  "accountsClosed": 3,
  "reclaimsCompleted": 2,
  "reclaimsFailed": 0,
  "totalRent": 12.50,
  "totalReclaimed": 4.52,
  "successRate": 100.0,
  "nextCheckIn": "2025-01-16T10:10:25Z"
}
```

## Examples

### Example 1: Monitor and Auto-Reclaim

```bash
# config.json has:
# - "autoReclaim": true
# - "dryRun": false
# - minRentToReclaim: 0.002 SOL

npm run monitor

# Output:
# [10:05] Checking 42 accounts...
# [10:05] Found 3 closed accounts
# [10:05] 2 are eligible for reclaim (>0.002 SOL rent)
# [10:05] Reclaiming from account A... ✓ (2.05 SOL)
# [10:05] Reclaiming from account B... ✓ (0.50 SOL)
# [10:06] Session complete: 4.52 SOL recovered
```

### Example 2: Dry-Run & Review

```bash
DRY_RUN=true npm run check:accounts

# Output shows what would be reclaimed without executing
# [10:05] DRY_RUN mode enabled
# [10:05] Would reclaim: 2.05 SOL from account A
# [10:05] Would reclaim: 0.50 SOL from account B
# [10:05] Would reclaim: 1.20 SOL from account C
# [10:05] TOTAL (if executed): 3.75 SOL
```

### Example 3: CLI with Specific Accounts

```bash
npm run reclaim -- \
  --accounts EPjFWdd5Au... 9B5X4... \
  --require-approval \
  --dry-run

# Prompts for approval before executing
```

## Project Structure

```
kora-rent-reclaim-bot/
├── src/
│   ├── index.ts                 # CLI entry point
│   ├── monitor.ts               # Service mode (cron)
│   ├── config.ts                # Configuration loader
│   ├── logger.ts                # Logging system
│   ├── types.ts                 # TypeScript interfaces
│   ├── solana/
│   │   ├── provider.ts          # Solana RPC wrapper
│   │   └── transactions.ts      # Transaction builders
│   ├── core/
│   │   ├── accountScanner.ts    # Find sponsored accounts
│   │   ├── rentCalculator.ts    # Rent amount logic
│   │   ├── reclaimHandler.ts    # Close account & reclaim
│   │   └── validator.ts         # Safety checks
│   ├── alerts/
│   │   ├── telegram.ts          # Telegram notifications
│   │   └── reporter.ts          # Report generation
│   └── utils/
│       ├── helpers.ts
│       └── constants.ts
├── config.json                  # Bot configuration
├── .env.example                 # Environment template
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### Issue: "Account not found"
- Ensure the account address is correct
- Verify RPC endpoint is working: `curl <RPC_URL>`
- Check that account exists on the target network (devnet vs mainnet)

### Issue: "Transaction failed: insufficient lamports"
- Bot's fee payer account doesn't have enough SOL
- Fund the operator keypair with SOL

### Issue: "Permission denied" when reclaiming
- Account has data or is not empty; can't close
- Account owner is not the operator; can't reclaim

### Issue: Monitoring not running
- Check logs: `npm run monitor 2>&1 | tee bot.log`
- Verify `.env` file exists and is correct
- Ensure operator keypair is readable

## Testing

```bash
# Test on devnet (recommended)
SOLANA_RPC_URL=https://api.devnet.solana.com npm run monitor

# With dry-run first
DRY_RUN=true npm run check:accounts

# Then with real transactions
npm run reclaim -- --accounts <TEST_ACCOUNT>
```

## Future Enhancements

- [ ] Web dashboard for monitoring
- [ ] Database persistence for historical data
- [ ] Multi-signature support
- [ ] Analytics and cost modeling
- [ ] Integration with Kora metrics endpoint
- [ ] Automatic SOL top-ups for fee payer
- [ ] Advanced filtering (e.g., by account size, creation date)
- [ ] Batch reclaim optimization

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request to [https://github.com/DVO1111/Kora](https://github.com/DVO1111/Kora).

## Security Considerations

- **Never commit private keys** to version control
- **Use environment variables** for sensitive config
- **Test on devnet first** before mainnet deployment
- **Monitor logs** for unexpected behavior
- **Keep backups** of successful reclaim transactions
- **Review code** before enabling auto-reclaim in production

## License

MIT

## Support

For questions or issues:
- Open an issue on [GitHub](https://github.com/DVO1111/Kora/issues)
- Ask on [Solana Stack Exchange](https://solana.stackexchange.com/) with `kora` tag
- Check [Kora docs](https://launch.solana.com/docs/kora)

---

**Disclaimer**: This bot is provided as-is. Test thoroughly before production use. The authors are not responsible for any loss of funds or data.
