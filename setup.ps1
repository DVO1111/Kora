# Kora Rent-Reclaim Bot Setup Script for Windows
# Run this script in PowerShell as Administrator if needed

Write-Host "Kora Rent-Reclaim Bot Setup" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVersion = node --version
    Write-Host "✓ Node.js $nodeVersion found" -ForegroundColor Green
} catch {
    Write-Host "Node.js not found. Please install Node.js 18+" -ForegroundColor Red
    exit 1
}

# Install dependencies
Write-Host ""
Write-Host "Installing dependencies..." -ForegroundColor Yellow
npm install

# Create directory structure
Write-Host ""
Write-Host "Creating directory structure..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path .\keys | Out-Null
New-Item -ItemType Directory -Force -Path .\logs | Out-Null
New-Item -ItemType Directory -Force -Path .\backups | Out-Null

# Check if .env exists
if (-not (Test-Path .\.env)) {
    Write-Host ""
    Write-Host "Creating .env file..." -ForegroundColor Yellow
    Copy-Item .\.env.example .\.env
    Write-Host "   Please edit .env with your configuration" -ForegroundColor Cyan
    Write-Host "   - SOLANA_RPC_URL" -ForegroundColor Cyan
    Write-Host "   - OPERATOR_KEYPAIR_PATH" -ForegroundColor Cyan
    Write-Host "   - OPERATOR_TREASURY_ADDRESS" -ForegroundColor Cyan
}

# Build TypeScript
Write-Host ""
Write-Host "Building TypeScript..." -ForegroundColor Yellow
npm run build

# Check if keypair exists
if (-not (Test-Path .\keys\operator-keypair.json)) {
    Write-Host ""
    Write-Host "No keypair found. Generating a new one..." -ForegroundColor Yellow
    Write-Host "   (This is for testing only. Replace with your real keypair.)" -ForegroundColor Cyan
    
    # Generate keypair using Node.js
    $script = @"
const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const kp = Keypair.generate();
fs.writeFileSync('./keys/operator-keypair.json', JSON.stringify(Array.from(kp.secretKey)));
console.log('Generated keypair: ' + kp.publicKey.toString());
"@
    node -e $script
}

Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "1. Edit .env file with your configuration" -ForegroundColor White
Write-Host "2. Create/update accounts.json with your account addresses" -ForegroundColor White
Write-Host "3. Test with: npm run check:accounts" -ForegroundColor White
Write-Host "4. Monitor with: npm run monitor" -ForegroundColor White
Write-Host ""
Write-Host "For help, see README.md or run: node dist/index.js --help" -ForegroundColor Cyan
