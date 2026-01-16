# Quick Start Guide - Kora Rent-Reclaim Bot

Get up and running in 5 minutes!

## Prerequisites

- Node.js 18+ (`node --version`)
- Solana CLI (optional, for keypair management)
- A Solana RPC endpoint (we'll use devnet for testing)
- Some SOL in an account (for fees)

## Step 1: Clone & Install

```bash
# Clone the repository
git clone <repo-url>
cd kora-rent-reclaim-bot

# Install dependencies
npm install

# Create necessary directories
mkdir -p keys logs backups
```

## Step 2: Create a Keypair

### Option A: Using Solana CLI

```bash
# Create a new keypair
solana-keygen new --outfile ./keys/operator-keypair.json

# Fund it with devnet SOL (if on devnet)
solana airdrop 2 --keypair ./keys/operator-keypair.json --url devnet
```

### Option B: Using our bot

```bash
# The bot will help you create one
npm run -- config
```

## Step 3: Configure

### 1. Create .env file

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
SOLANA_RPC_URL=https://api.devnet.solana.com
OPERATOR_KEYPAIR_PATH=./keys/operator-keypair.json
OPERATOR_TREASURY_ADDRESS=<YOUR_WALLET_ADDRESS>
OPERATOR_NAME=My Kora Operator
DRY_RUN=true
LOG_LEVEL=info
```

### 2. Create config.json

The default `config.json` should work. Key settings:

```json
{
  "network": "devnet",
  "rpcUrl": "https://api.devnet.solana.com",
  "treasuryAddress": "<YOUR_WALLET>",
  "reclaimPolicy": {
    "autoReclaim": false,
    "minRentToReclaim": 0.002
  },
  "safety": {
    "dryRun": true,
    "minAccountAge": 30
  }
}
```

### 3. Create accounts.json

List the accounts you want to monitor:

```json
[
  {
    "address": "EPjFWdd5Au3yAB32yxXaYxPoxZBBPrxGZqvYNS6JRfp",
    "createdAt": "2025-01-01T00:00:00Z"
  }
]
```

## Step 4: Test

### Build the project

```bash
npm run build
```

### Check your balance

```bash
npm run balance
```

Expected output:
```
Operator balance: 1.2345 SOL
```

### Check account status

```bash
npm run check:accounts
```

Output:
```
[2025-01-16 10:05:15] === Session Start === Operator: My Kora Operator | Monitoring 1 accounts
[2025-01-16 10:05:17] Account: EPjF... | Status: OPEN | Rent: 2.05 SOL
[2025-01-16 10:05:17] === Summary ===
Total Accounts: 1
Total Rent Locked: 2.05 SOL
Accounts with Rent: 1
Eligible for Reclaim: 0
Total Reclaimable: 0 SOL
```

## Step 5: Run in Monitor Mode

```bash
# Start continuous monitoring (dry-run mode)
npm run monitor

# Output:
# [10:05] Starting monitoring service (interval: 5 minutes)
# [10:05] Starting scheduled monitoring session...
# [10:05] === Session Start ===
# ...
```

## Step 6: Test Reclaim (Dry-Run)

```bash
# Preview what would be reclaimed without executing
npm run reclaim -- --dry-run

# Output:
# [DRY_RUN] Would reclaim 2.05 SOL from account EPjF...
# [DRY_RUN] Total (if executed): 2.05 SOL
```

## Step 7: Enable Live Reclaim (Optional)

Once you're confident:

1. Update `.env`:
   ```env
   DRY_RUN=false
   ```

2. Or update `config.json`:
   ```json
   "safety": {
     "dryRun": false
   }
   ```

3. Run with approval:
   ```bash
   npm run reclaim -- --approve
   ```

## Common Commands

```bash
# Check account status
npm run check:accounts

# Reclaim in dry-run mode
npm run reclaim -- --dry-run

# Reclaim with approval
npm run reclaim -- --approve

# Start monitoring service
npm run monitor

# Show current configuration
npm run -- config

# Check balance
npm run balance

# Generate report
npm run -- report --format json
```

## Monitoring in Production

### Using PM2

```bash
# Install PM2 globally
npm install -g pm2

# Start the bot
pm2 start dist/monitor.js --name kora-bot

# View logs
pm2 logs kora-bot

# Auto-restart on reboot
pm2 startup
pm2 save
```

### Using Systemd (Linux)

Create `/etc/systemd/system/kora-bot.service`:

```ini
[Unit]
Description=Kora Rent-Reclaim Bot
After=network.target

[Service]
Type=simple
User=solana
WorkingDirectory=/home/solana/kora-rent-reclaim-bot
ExecStart=/usr/bin/node dist/monitor.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl enable kora-bot
sudo systemctl start kora-bot
sudo systemctl logs -u kora-bot -f
```

### Using Docker

Create `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
CMD ["node", "dist/monitor.js"]
```

Run:

```bash
docker build -t kora-bot .
docker run -v $(pwd)/.env:/app/.env \
           -v $(pwd)/accounts.json:/app/accounts.json \
           -v $(pwd)/keys:/app/keys \
           kora-bot
```

## Troubleshooting

### Issue: "Config file not found"

```bash
# Make sure config.json exists
ls -la config.json

# If missing, copy from example
cp config.json.example config.json
```

### Issue: "Keypair not found"

```bash
# Check keypair path
ls -la ./keys/operator-keypair.json

# Create new keypair
solana-keygen new --outfile ./keys/operator-keypair.json
```

### Issue: "Cannot connect to RPC"

```bash
# Test RPC endpoint
curl https://api.devnet.solana.com -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'
```

### Issue: "Insufficient lamports"

```bash
# Fund the keypair
solana airdrop 2 \
  --keypair ./keys/operator-keypair.json \
  --url devnet
```

### Issue: "Account not found"

```bash
# Verify account exists on devnet
# Visit: https://solscan.io/account/<ADDRESS>?cluster=devnet

# Or query RPC
curl https://api.devnet.solana.com -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["<ADDRESS>"]}'
```

## Next Steps

1. **Read the README**: Full documentation and advanced usage
2. **Review DEEP_DIVE.md**: Technical deep-dive into rent mechanics
3. **Set up Telegram alerts**: Get notified of reclaims
4. **Deploy to production**: Use PM2, Docker, or your favorite orchestrator
5. **Monitor continuously**: Schedule regular reports

## Support

- Check logs: `tail -f logs/bot.log`
- Enable debug: `LOG_LEVEL=debug npm run monitor`
- Ask questions: [Solana Stack Exchange](https://solana.stackexchange.com/) with `kora` tag
- Report issues: GitHub Issues

---

**Ready to recover your rent?**

Let us know how it goes!
