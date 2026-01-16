# Kora Rent-Reclaim Bot Dockerfile
# Multi-stage build for smaller image size

# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S kora && \
    adduser -S kora -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built files
COPY --from=builder /app/dist ./dist

# Create directories
RUN mkdir -p /app/keys /app/logs /app/backups && \
    chown -R kora:kora /app

# Switch to non-root user
USER kora

# Environment variables (override with docker run -e)
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV SOLANA_RPC_URL=https://api.devnet.solana.com
ENV CONFIG_PATH=/app/config.json

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Default command - run monitor
CMD ["node", "dist/monitor.js"]

# Alternative commands:
# - Check accounts: docker run <image> node dist/index.js check
# - Show config: docker run <image> node dist/index.js config
# - Reclaim: docker run <image> node dist/index.js reclaim --dry-run
