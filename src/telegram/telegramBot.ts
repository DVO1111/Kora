/**
 * KORA RENT RECLAIM BOT - TELEGRAM INTERFACE
 * 
 * Provides a Telegram bot frontend for the Kora rent-reclaim system.
 * Operators can monitor and manage their sponsored accounts via Telegram.
 * 
 * COMMANDS:
 * /start    - Welcome message and setup instructions
 * /help     - Show available commands
 * /status   - Show operator status and metrics
 * /scan     - Scan for reclaimable accounts
 * /report   - Generate detailed report
 * /watch    - Start/stop automatic monitoring
 * /reclaim  - Execute reclaim (requires confirmation)
 * /settings - View/update bot settings
 */

import TelegramBot from "node-telegram-bot-api";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { KoraSponsorshipTracker } from "../core/sponsorshipTracker.js";
import { SafeRentReclaimer, DEFAULT_SAFETY_CONFIG } from "../core/safeReclaimer.js";

// ============================================================================
// TYPES
// ============================================================================

interface BotConfig {
  telegramToken: string;
  rpcUrl: string;
  operatorAddress: string;
  treasuryAddress: string;
  privateKeyPath?: string;
  authorizedUsers: number[]; // Telegram user IDs allowed to use the bot
}

interface WatchState {
  active: boolean;
  intervalMinutes: number;
  autoReclaim: boolean;
  intervalId?: NodeJS.Timeout;
}

interface UserSession {
  chatId: number;
  watchState: WatchState;
  pendingReclaim: boolean;
  lastScanResult?: {
    reclaimableCount: number;
    totalSol: number;
    timestamp: Date;
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function formatSol(lamports: number): string {
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

// ============================================================================
// TELEGRAM BOT CLASS
// ============================================================================

export class KoraTelegramBot {
  private bot: TelegramBot;
  private config: BotConfig;
  private sessions: Map<number, UserSession> = new Map();
  private tracker: KoraSponsorshipTracker | null = null;

  constructor(config: BotConfig) {
    this.config = config;
    this.bot = new TelegramBot(config.telegramToken, { polling: true });
    this.setupCommands();
  }

  // --------------------------------------------------------------------------
  // AUTHORIZATION
  // --------------------------------------------------------------------------

  private isAuthorized(userId: number): boolean {
    // If no authorized users configured, allow all
    if (this.config.authorizedUsers.length === 0) return true;
    return this.config.authorizedUsers.includes(userId);
  }

  private getSession(chatId: number): UserSession {
    if (!this.sessions.has(chatId)) {
      this.sessions.set(chatId, {
        chatId,
        watchState: {
          active: false,
          intervalMinutes: 60,
          autoReclaim: false,
        },
        pendingReclaim: false,
      });
    }
    return this.sessions.get(chatId)!;
  }

  private getTracker(): KoraSponsorshipTracker {
    if (!this.tracker) {
      this.tracker = new KoraSponsorshipTracker(
        this.config.rpcUrl,
        this.config.operatorAddress,
        "./data/sponsorship-registry.json"
      );
    }
    return this.tracker;
  }

  // --------------------------------------------------------------------------
  // COMMAND SETUP
  // --------------------------------------------------------------------------

  private setupCommands(): void {
    // Set bot commands menu
    this.bot.setMyCommands([
      { command: "start", description: "Welcome & setup" },
      { command: "help", description: "Show commands" },
      { command: "status", description: "Operator status & metrics" },
      { command: "scan", description: "Scan for reclaimable accounts" },
      { command: "report", description: "Detailed report" },
      { command: "watch", description: "Toggle auto-monitoring" },
      { command: "reclaim", description: "Reclaim eligible accounts" },
      { command: "settings", description: "View settings" },
    ]);

    // Command handlers
    this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
    this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));
    this.bot.onText(/\/status/, (msg) => this.handleStatus(msg));
    this.bot.onText(/\/scan/, (msg) => this.handleScan(msg));
    this.bot.onText(/\/report/, (msg) => this.handleReport(msg));
    this.bot.onText(/\/watch(?:\s+(\d+))?/, (msg, match) => this.handleWatch(msg, match));
    this.bot.onText(/\/reclaim/, (msg) => this.handleReclaim(msg));
    this.bot.onText(/\/settings/, (msg) => this.handleSettings(msg));
    this.bot.onText(/\/confirm_reclaim/, (msg) => this.handleConfirmReclaim(msg));
    this.bot.onText(/\/cancel/, (msg) => this.handleCancel(msg));

    // Callback query handler for inline buttons
    this.bot.on("callback_query", (query) => this.handleCallbackQuery(query));

    console.log(`[${formatTimestamp()}] Telegram bot initialized`);
  }

  // --------------------------------------------------------------------------
  // COMMAND HANDLERS
  // --------------------------------------------------------------------------

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) {
      await this.bot.sendMessage(chatId, "You are not authorized to use this bot.");
      return;
    }

    const welcome = `
*KORA RENT RECLAIM BOT*

Welcome! This bot helps you recover locked SOL from Kora-sponsored accounts.

*Quick Setup:*
1. Ensure your operator address is configured
2. Run /scan to find reclaimable accounts
3. Use /reclaim to recover SOL (with safety checks)

*Current Configuration:*
• Operator: \`${this.config.operatorAddress || "Not set"}\`
• RPC: \`${this.config.rpcUrl.substring(0, 40)}...\`

Use /help to see all commands.
    `;

    await this.bot.sendMessage(chatId, welcome, { parse_mode: "Markdown" });
  }

  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) return;

    const help = `
*Available Commands:*

/status - Show operator status and metrics
/scan - Scan for accounts eligible for reclaim
/report - Generate detailed reclaim report
/watch [minutes] - Start auto-monitoring (default: 60 min)
/watch off - Stop auto-monitoring
/reclaim - Reclaim eligible accounts (requires confirmation)
/settings - View current settings

*Safety Features:*
• All reclaims require confirmation
• Only empty/inactive accounts are touched
• 7-day minimum account age
• Dry-run available before execution
    `;

    await this.bot.sendMessage(chatId, help, { parse_mode: "Markdown" });
  }

  private async handleStatus(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) return;

    if (!this.config.operatorAddress) {
      await this.bot.sendMessage(chatId, "Operator address not configured.");
      return;
    }

    const statusMsg = await this.bot.sendMessage(chatId, "Fetching status...");

    try {
      const tracker = this.getTracker();
      const metrics = tracker.getMetrics();
      const session = this.getSession(chatId);

      const connection = new Connection(this.config.rpcUrl, "confirmed");
      const pubkey = new PublicKey(this.config.operatorAddress);
      const balance = await connection.getBalance(pubkey);

      const status = `
*OPERATOR STATUS*

*Wallet:*
• Address: \`${this.config.operatorAddress.slice(0, 8)}...${this.config.operatorAddress.slice(-8)}\`
• Balance: ${formatSol(balance)}

*Sponsorship Metrics:*
• Total Sponsored: ${metrics.totalAccountsSponsored}
• Total Rent Locked: ${formatSol(metrics.totalRentLocked)}
• Reclaimed: ${formatSol(metrics.totalRentReclaimed)}
• Pending: ${formatSol(metrics.totalRentLocked - metrics.totalRentReclaimed)}

*Watch Mode:*
• Status: ${session.watchState.active ? "ACTIVE" : "Inactive"}
${session.watchState.active ? `• Interval: ${session.watchState.intervalMinutes} minutes` : ""}
${session.watchState.active ? `• Auto-reclaim: ${session.watchState.autoReclaim ? "Yes" : "No"}` : ""}
      `;

      await this.bot.editMessageText(status, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: "Markdown",
      });
    } catch (error) {
      await this.bot.editMessageText(`Error: ${(error as Error).message}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
    }
  }

  private async handleScan(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) return;

    if (!this.config.operatorAddress) {
      await this.bot.sendMessage(chatId, "Operator address not configured.");
      return;
    }

    const scanMsg = await this.bot.sendMessage(chatId, "Scanning for reclaimable accounts...");

    try {
      const tracker = this.getTracker();
      const result = await tracker.refreshAccountStatuses();
      const reclaimable = tracker.getReclaimableAccounts();

      let totalReclaimable = 0;
      for (const acc of reclaimable) {
        totalReclaimable += acc.rentLamports;
      }

      // Store result in session
      const session = this.getSession(chatId);
      session.lastScanResult = {
        reclaimableCount: reclaimable.length,
        totalSol: totalReclaimable,
        timestamp: new Date(),
      };

      let scanResult = `
*SCAN COMPLETE*

*Account Status:*
• Active: ${result.active}
• Empty: ${result.empty}
• Closed: ${result.closed}
• Updated: ${result.updated}

*Reclaimable:*
• Accounts: ${reclaimable.length}
• Total SOL: ${formatSol(totalReclaimable)}
`;

      if (reclaimable.length > 0) {
        scanResult += `
Use /reclaim to recover this SOL.
        `;
      } else {
        scanResult += `
No accounts eligible for reclaim at this time.
        `;
      }

      await this.bot.editMessageText(scanResult, {
        chat_id: chatId,
        message_id: scanMsg.message_id,
        parse_mode: "Markdown",
      });
    } catch (error) {
      await this.bot.editMessageText(`Scan error: ${(error as Error).message}`, {
        chat_id: chatId,
        message_id: scanMsg.message_id,
      });
    }
  }

  private async handleReport(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) return;

    const reportMsg = await this.bot.sendMessage(chatId, "Generating report...");

    try {
      const tracker = this.getTracker();
      const metrics = tracker.getMetrics();
      const reclaimable = tracker.getReclaimableAccounts();

      let totalReclaimable = 0;
      for (const acc of reclaimable) {
        totalReclaimable += acc.rentLamports;
      }

      // Get recent reclaim history
      const reportDir = "./data/reclaim-reports";
      let recentReclaims = "No recent reclaims";

      if (fs.existsSync(reportDir)) {
        const files = fs.readdirSync(reportDir)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .reverse()
          .slice(0, 5);

        if (files.length > 0) {
          recentReclaims = "";
          for (const file of files) {
            const report = JSON.parse(
              fs.readFileSync(`${reportDir}/${file}`, "utf-8")
            );
            const date = file.replace("reclaim-", "").replace(".json", "");
            recentReclaims += `• ${date}: ${formatSol(report.totalLamportsReclaimed)} (${report.accountsReclaimed} accounts)\n`;
          }
        }
      }

      const report = `
*KORA RECLAIM REPORT*

*Lifetime Statistics:*
• Total Sponsored: ${metrics.totalAccountsSponsored} accounts
• Total Rent Locked: ${formatSol(metrics.totalRentLocked)}
• Total Reclaimed: ${formatSol(metrics.totalRentReclaimed)}
• Recovery Rate: ${metrics.totalRentLocked > 0 ? ((metrics.totalRentReclaimed / metrics.totalRentLocked) * 100).toFixed(1) : 0}%

*Current Status:*
• Pending Reclaim: ${formatSol(totalReclaimable)}
• Eligible Accounts: ${reclaimable.length}

*Recent Reclaims:*
${recentReclaims}
      `;

      await this.bot.editMessageText(report, {
        chat_id: chatId,
        message_id: reportMsg.message_id,
        parse_mode: "Markdown",
      });
    } catch (error) {
      await this.bot.editMessageText(`Report error: ${(error as Error).message}`, {
        chat_id: chatId,
        message_id: reportMsg.message_id,
      });
    }
  }

  private async handleWatch(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) return;

    const session = this.getSession(chatId);
    const arg = match?.[1];

    // Check if turning off
    if (msg.text?.includes("off")) {
      if (session.watchState.intervalId) {
        clearInterval(session.watchState.intervalId);
      }
      session.watchState.active = false;
      await this.bot.sendMessage(chatId, "Watch mode disabled.");
      return;
    }

    // Parse interval or use default
    const interval = arg ? parseInt(arg) : 60;

    if (session.watchState.intervalId) {
      clearInterval(session.watchState.intervalId);
    }

    session.watchState.active = true;
    session.watchState.intervalMinutes = interval;

    // Start watching
    const runWatch = async () => {
      try {
        const tracker = this.getTracker();
        await tracker.refreshAccountStatuses();
        const reclaimable = tracker.getReclaimableAccounts();

        let totalReclaimable = 0;
        for (const acc of reclaimable) {
          totalReclaimable += acc.rentLamports;
        }

        const timestamp = formatTimestamp();
        let watchLog = `[${timestamp}] *Auto-scan complete*\n`;
        watchLog += `• Found: ${reclaimable.length} accounts eligible\n`;
        watchLog += `• Reclaimable: ${formatSol(totalReclaimable)}`;

        if (reclaimable.length > 0) {
          watchLog += `\n\nUse /reclaim to recover.`;
        }

        await this.bot.sendMessage(chatId, watchLog, { parse_mode: "Markdown" });
      } catch (error) {
        await this.bot.sendMessage(
          chatId,
          `[${formatTimestamp()}] Watch scan error: ${(error as Error).message}`
        );
      }
    };

    // Run immediately
    await runWatch();

    // Schedule future runs
    session.watchState.intervalId = setInterval(runWatch, interval * 60 * 1000);

    await this.bot.sendMessage(
      chatId,
      `Watch mode enabled. Scanning every ${interval} minutes.\nUse /watch off to disable.`
    );
  }

  private async handleReclaim(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) return;

    if (!this.config.privateKeyPath) {
      await this.bot.sendMessage(
        chatId,
        "Private key not configured. Cannot execute reclaims."
      );
      return;
    }

    try {
      const tracker = this.getTracker();
      const reclaimable = tracker.getReclaimableAccounts();

      if (reclaimable.length === 0) {
        await this.bot.sendMessage(
          chatId,
          "No accounts eligible for reclaim. Run /scan first."
        );
        return;
      }

      let totalReclaimable = 0;
      for (const acc of reclaimable) {
        totalReclaimable += acc.rentLamports;
      }

      const session = this.getSession(chatId);
      session.pendingReclaim = true;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "Dry Run First", callback_data: "reclaim_dry" },
            { text: "Execute Reclaim", callback_data: "reclaim_execute" },
          ],
          [{ text: "Cancel", callback_data: "reclaim_cancel" }],
        ],
      };

      await this.bot.sendMessage(
        chatId,
        `*RECLAIM CONFIRMATION*

Ready to reclaim:
• Accounts: ${reclaimable.length}
• Total SOL: ${formatSol(totalReclaimable)}
• Treasury: \`${this.config.treasuryAddress || this.config.operatorAddress}\`

Choose an action:`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
    } catch (error) {
      await this.bot.sendMessage(chatId, `Error: ${(error as Error).message}`);
    }
  }

  private async handleConfirmReclaim(msg: TelegramBot.Message): Promise<void> {
    // Handled by callback query
  }

  private async handleCancel(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const session = this.getSession(chatId);
    session.pendingReclaim = false;
    await this.bot.sendMessage(chatId, "Operation cancelled.");
  }

  private async handleSettings(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) return;

    const session = this.getSession(chatId);

    const settings = `
*BOT SETTINGS*

*Network:*
• RPC: \`${this.config.rpcUrl}\`

*Operator:*
• Address: \`${this.config.operatorAddress || "Not set"}\`
• Treasury: \`${this.config.treasuryAddress || "Same as operator"}\`
• Key configured: ${this.config.privateKeyPath ? "Yes" : "No"}

*Watch Mode:*
• Status: ${session.watchState.active ? "Active" : "Inactive"}
• Interval: ${session.watchState.intervalMinutes} minutes
• Auto-reclaim: ${session.watchState.autoReclaim ? "Enabled" : "Disabled"}

*Authorization:*
• Your ID: ${userId}
• Authorized: ${this.isAuthorized(userId) ? "Yes" : "No"}
    `;

    await this.bot.sendMessage(chatId, settings, { parse_mode: "Markdown" });
  }

  // --------------------------------------------------------------------------
  // CALLBACK QUERY HANDLER
  // --------------------------------------------------------------------------

  private async handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (!chatId || !userId || !this.isAuthorized(userId)) {
      await this.bot.answerCallbackQuery(query.id, { text: "Not authorized" });
      return;
    }

    const session = this.getSession(chatId);

    if (data === "reclaim_cancel") {
      session.pendingReclaim = false;
      await this.bot.answerCallbackQuery(query.id, { text: "Cancelled" });
      await this.bot.editMessageText("Reclaim cancelled.", {
        chat_id: chatId,
        message_id: query.message?.message_id,
      });
      return;
    }

    if (data === "reclaim_dry" || data === "reclaim_execute") {
      const isDryRun = data === "reclaim_dry";

      await this.bot.answerCallbackQuery(query.id, {
        text: isDryRun ? "Running dry run..." : "Executing reclaim...",
      });

      await this.bot.editMessageText(
        isDryRun ? "Running dry run..." : "Executing reclaim...",
        { chat_id: chatId, message_id: query.message?.message_id }
      );

      try {
        const tracker = this.getTracker();
        const reclaimable = tracker.getReclaimableAccounts();

        const reclaimer = new SafeRentReclaimer(
          this.config.rpcUrl,
          this.config.privateKeyPath || null,
          this.config.treasuryAddress || this.config.operatorAddress,
          { maxAccountsPerRun: 10 }
        );

        const report = await reclaimer.executeReclaim(
          reclaimable,
          isDryRun,
          (account) => {
            if (!isDryRun) {
              tracker.recordReclaim(account.address, account.rentLamports);
            }
          }
        );

        let result = isDryRun ? "*DRY RUN COMPLETE*\n\n" : "*RECLAIM COMPLETE*\n\n";
        result += `• Accounts analyzed: ${report.accountsAnalyzed}\n`;
        result += `• Accounts ${isDryRun ? "would be " : ""}reclaimed: ${report.accountsReclaimed}\n`;
        result += `• SOL ${isDryRun ? "would be " : ""}recovered: ${formatSol(report.totalLamportsReclaimed)}\n`;
        result += `• Validated: ${report.accountsValidated}\n`;
        result += `• Failed: ${report.accountsFailed}`;

        if (isDryRun && report.accountsReclaimed > 0) {
          result += "\n\nUse /reclaim again and choose 'Execute Reclaim' to proceed.";
        }

        await this.bot.editMessageText(result, {
          chat_id: chatId,
          message_id: query.message?.message_id,
          parse_mode: "Markdown",
        });
      } catch (error) {
        await this.bot.editMessageText(`Error: ${(error as Error).message}`, {
          chat_id: chatId,
          message_id: query.message?.message_id,
        });
      }

      session.pendingReclaim = false;
    }
  }

  // --------------------------------------------------------------------------
  // PUBLIC METHODS
  // --------------------------------------------------------------------------

  public async sendNotification(chatId: number, message: string): Promise<void> {
    await this.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  }

  public stop(): void {
    this.bot.stopPolling();
    // Clear all watch intervals
    for (const session of this.sessions.values()) {
      if (session.watchState.intervalId) {
        clearInterval(session.watchState.intervalId);
      }
    }
    console.log(`[${formatTimestamp()}] Telegram bot stopped`);
  }
}

// ============================================================================
// STANDALONE RUNNER
// ============================================================================

export function loadBotConfig(): BotConfig {
  const configPath = process.env.KORA_CONFIG || "config.json";
  let config: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // Ignore
    }
  }

  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || (config.telegramToken as string) || "",
    rpcUrl: process.env.SOLANA_RPC_URL || (config.rpcUrl as string) || "https://api.devnet.solana.com",
    operatorAddress: process.env.OPERATOR_ADDRESS || (config.operatorAddress as string) || "",
    treasuryAddress: process.env.TREASURY_ADDRESS || (config.treasuryAddress as string) || "",
    privateKeyPath: process.env.PRIVATE_KEY_PATH || (config.privateKeyPath as string),
    authorizedUsers: (config.authorizedUsers as number[]) || [],
  };
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const config = loadBotConfig();

  if (!config.telegramToken) {
    console.error("Error: TELEGRAM_BOT_TOKEN not set");
    console.error("Set it via environment variable or in config.json");
    process.exit(1);
  }

  if (!config.operatorAddress) {
    console.error("Error: OPERATOR_ADDRESS not set");
    process.exit(1);
  }

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   KORA RENT RECLAIM BOT - TELEGRAM MODE                      ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
  console.log(`[${formatTimestamp()}] Starting Telegram bot...`);
  console.log(`[${formatTimestamp()}] Operator: ${config.operatorAddress}`);
  console.log(`[${formatTimestamp()}] RPC: ${config.rpcUrl}`);

  const bot = new KoraTelegramBot(config);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log(`\n[${formatTimestamp()}] Shutting down...`);
    bot.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    bot.stop();
    process.exit(0);
  });
}
