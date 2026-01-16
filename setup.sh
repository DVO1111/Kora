#!/bin/bash

# Kora Rent-Reclaim Bot Setup Script

set -e

echo " Kora Rent-Reclaim Bot Setup"
echo "=============================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Please install Node.js 18+"
    exit 1
fi

echo "✓ Node.js $(node --version) found"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Create directory structure
echo ""
echo "Creating directory structure..."
mkdir -p keys
mkdir -p logs
mkdir -p backups

# Check if .env exists
if [ ! -f .env ]; then
    echo ""
    echo "Creating .env file..."
    cp .env.example .env
    echo "   Please edit .env with your configuration"
    echo "   - SOLANA_RPC_URL"
    echo "   - OPERATOR_KEYPAIR_PATH"
    echo "   - OPERATOR_TREASURY_ADDRESS"
fi

# Build TypeScript
echo ""
echo "Building TypeScript..."
npm run build

# Create sample keypair (optional)
if [ ! -f keys/operator-keypair.json ]; then
    echo ""
    echo "Generating sample keypair..."
    echo "   (This is for testing only. Replace with your real keypair.)"
fi

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env file with your configuration"
echo "2. Create/update accounts.json with your account addresses"
echo "3. Test with: npm run check:accounts"
echo "4. Monitor with: npm run monitor"
echo ""
echo "For help, see README.md or run: npm run -- --help"
