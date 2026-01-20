// PM2 Ecosystem Configuration for Kora Telegram Bot
// Run with: pm2 start ecosystem.config.cjs

module.exports = {
  apps: [
    {
      name: "kora-telegram-bot",
      script: "dist/telegram/telegramBot.js",
      cwd: "C:/Kora",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
      // Restart on failure with exponential backoff
      exp_backoff_restart_delay: 1000,
      // Log configuration
      error_file: "logs/telegram-error.log",
      out_file: "logs/telegram-out.log",
      log_file: "logs/telegram-combined.log",
      time: true,
      // Graceful shutdown
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
    },
  ],
};
