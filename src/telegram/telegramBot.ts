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
import { PhantomDeepLink, shortenAddress as shortAddr, formatSolAmount } from "../core/phantomDeepLink.js";

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
      { command: "myreclaim", description: "Reclaim YOUR empty token accounts" },
      { command: "analyze", description: "Analyze any wallet address" },
      { command: "status", description: "Operator status & metrics" },
      { command: "scan", description: "Scan for reclaimable accounts" },
      { command: "report", description: "Detailed report" },
      { command: "watch", description: "Toggle auto-monitoring" },
      { command: "reclaim", description: "Reclaim operator accounts" },
      { command: "settings", description: "View settings" },
    ]);

    // Command handlers
    this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
    this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));
    this.bot.onText(/\/myreclaim(?:\s+(.+))?/, (msg, match) => this.handleMyReclaim(msg, match));
    this.bot.onText(/\/status/, (msg) => this.handleStatus(msg));
    this.bot.onText(/\/scan/, (msg) => this.handleScan(msg));
    this.bot.onText(/\/report/, (msg) => this.handleReport(msg));
    this.bot.onText(/\/watch(?:\s+(\d+))?/, (msg, match) => this.handleWatch(msg, match));
    this.bot.onText(/\/reclaim/, (msg) => this.handleReclaim(msg));
    this.bot.onText(/\/settings/, (msg) => this.handleSettings(msg));
    this.bot.onText(/\/confirm_reclaim/, (msg) => this.handleConfirmReclaim(msg));
    this.bot.onText(/\/cancel/, (msg) => this.handleCancel(msg));
    this.bot.onText(/\/analyze(?:\s+(.+))?/, (msg, match) => this.handleAnalyze(msg, match));

    // Callback query handler for inline buttons
    this.bot.on("callback_query", (query) => this.handleCallbackQuery(query));

    // Handle plain text messages (wallet addresses)
    this.bot.on("message", (msg) => this.handleMessage(msg));

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

Welcome! This bot helps you analyze Solana wallets and track Kora-sponsored accounts.

*Quick Start:*
Paste any Solana wallet address to analyze it!

*What you can do:*
• View wallet balance and token accounts
• See recent transaction activity  
• Analyze sponsorship patterns
• Track rent locked in token accounts

*Current Configuration:*
• Operator: \`${this.config.operatorAddress || "Not set"}\`
• RPC: \`${this.config.rpcUrl.substring(0, 40)}...\`

Use /help to see all commands.

*Try it now:* Just paste a wallet address!
    `;

    await this.bot.sendMessage(chatId, welcome, { parse_mode: "Markdown" });
  }

  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) return;

    const help = `
*KORA RENT RECLAIM BOT*

*Wallet Analysis:*
Just paste any Solana address to analyze it!

/analyze [address] - Analyze a wallet address

*Reclaim YOUR Rent:*
/myreclaim [address] - Get links to reclaim YOUR empty token accounts
(No private keys needed - sign with Phantom/Solflare!)

*Operator Commands:*
/status - Show operator status and metrics
/scan - Scan for accounts eligible for reclaim
/report - Generate detailed reclaim report
/watch [minutes] - Start auto-monitoring (default: 60 min)
/watch off - Stop auto-monitoring
/reclaim - Reclaim operator accounts (requires key)
/settings - View current settings

*How to Use:*
1. Paste any Solana wallet address
2. View balance, tokens, and activity
3. Use /myreclaim to close empty accounts and get SOL back!

*Safety Features:*
• Only empty token accounts can be closed
• You sign with YOUR wallet (Phantom/Solflare)
• No private keys shared with the bot
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

    // Handle analyze as operator button
    if (data?.startsWith("analyze_operator_")) {
      const address = data.replace("analyze_operator_", "");
      await this.bot.answerCallbackQuery(query.id, { text: "Analyzing as operator..." });
      await this.analyzeAsOperator(chatId, address);
      return;
    }

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

    // Handle myreclaim callback buttons
    if (data?.startsWith("myreclaim_")) {
      const parts = data.split("_");
      const action = parts[1];
      const walletAddress = parts.slice(2).join("_");

      if (action === "all") {
        await this.bot.answerCallbackQuery(query.id, { text: "Generating transaction..." });
        await this.generateReclaimLinks(chatId, walletAddress);
      } else if (action === "batch") {
        const batchNum = parseInt(parts[2]);
        const address = parts.slice(3).join("_");
        await this.bot.answerCallbackQuery(query.id, { text: `Generating batch ${batchNum}...` });
        await this.generateReclaimLinks(chatId, address, batchNum);
      }
      return;
    }
  }

  // --------------------------------------------------------------------------
  // USER RECLAIM (PHANTOM/SOLFLARE DEEP LINKS)
  // --------------------------------------------------------------------------

  /**
   * Handle /myreclaim command - let users reclaim their own empty token accounts
   */
  private async handleMyReclaim(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) return;

    const walletAddress = match?.[1]?.trim();

    if (!walletAddress) {
      await this.bot.sendMessage(
        chatId,
        `*RECLAIM YOUR RENT*

Send your wallet address to find empty token accounts you can close to get SOL back!

Usage: \`/myreclaim <your-wallet-address>\`

Example:
\`/myreclaim 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU\`

*How it works:*
1. We scan your wallet for empty token accounts
2. You get links to sign with Phantom or Solflare
3. You approve the transaction in your wallet
4. Rent is returned to your wallet!

No private keys needed - you sign everything yourself.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (!this.isValidSolanaAddress(walletAddress)) {
      await this.bot.sendMessage(chatId, "Invalid Solana address format. Please check and try again.");
      return;
    }

    await this.scanForUserReclaim(chatId, walletAddress);
  }

  /**
   * Scan wallet for closable token accounts
   */
  private async scanForUserReclaim(chatId: number, walletAddress: string): Promise<void> {
    const statusMsg = await this.bot.sendMessage(
      chatId,
      `Scanning \`${walletAddress}\` for empty token accounts...`,
      { parse_mode: "Markdown" }
    );

    try {
      const phantom = new PhantomDeepLink(this.config.rpcUrl);
      const summary = await phantom.getWalletReclaimSummary(walletAddress);

      if (summary.closable.length === 0) {
        let message = `*NO EMPTY ACCOUNTS FOUND*

Wallet: \`${walletAddress}\`

`;
        if (summary.nonClosable.length > 0) {
          message += `Found ${summary.nonClosable.length} token account(s) with balances:\n`;
          for (const acc of summary.nonClosable.slice(0, 5)) {
            message += `• \`${shortAddr(acc.address)}\` - ${acc.reason}\n`;
          }
          if (summary.nonClosable.length > 5) {
            message += `...and ${summary.nonClosable.length - 5} more\n`;
          }
          message += `\nTransfer tokens out first to close these accounts.`;
        } else {
          message += `This wallet has no token accounts to close.`;
        }

        await this.bot.editMessageText(message, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "Markdown",
        });
        return;
      }

      // Found closable accounts!
      let message = `*FOUND ${summary.closable.length} EMPTY TOKEN ACCOUNT${summary.closable.length > 1 ? "S" : ""}*

Wallet: \`${walletAddress}\`
Total Reclaimable: *${summary.totalReclaimableSol} SOL*

*Empty accounts:*\n`;

      for (const acc of summary.closable.slice(0, 10)) {
        message += `• \`${shortAddr(acc.address)}\` - ${formatSolAmount(acc.rentLamports)}\n`;
      }

      if (summary.closable.length > 10) {
        message += `...and ${summary.closable.length - 10} more\n`;
      }

      // Create action buttons
      const keyboard: TelegramBot.InlineKeyboardMarkup = {
        inline_keyboard: [],
      };

      if (summary.closable.length <= 10) {
        // Can close all in one transaction
        keyboard.inline_keyboard.push([
          { text: `Close All (${summary.totalReclaimableSol} SOL)`, callback_data: `myreclaim_all_${walletAddress}` }
        ]);
      } else {
        // Need multiple batches
        const batches = Math.ceil(summary.closable.length / 10);
        message += `\n_Note: Max 10 accounts per transaction. You'll need ${batches} transactions._\n`;
        
        for (let i = 0; i < Math.min(batches, 3); i++) {
          const batchAccounts = summary.closable.slice(i * 10, (i + 1) * 10);
          const batchRent = batchAccounts.reduce((sum, a) => sum + a.rentLamports, 0);
          keyboard.inline_keyboard.push([
            { text: `Batch ${i + 1}: ${batchAccounts.length} accounts (${formatSolAmount(batchRent)})`, callback_data: `myreclaim_batch_${i}_${walletAddress}` }
          ]);
        }
      }

      if (summary.nonClosable.length > 0) {
        message += `\n_${summary.nonClosable.length} account(s) have balances and cannot be closed._`;
      }

      await this.bot.editMessageText(message, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } catch (error) {
      await this.bot.editMessageText(`Error scanning wallet: ${(error as Error).message}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
    }
  }

  /**
   * Generate Phantom/Solflare deep links for closing accounts
   */
  private async generateReclaimLinks(chatId: number, walletAddress: string, batchNum?: number): Promise<void> {
    const statusMsg = await this.bot.sendMessage(chatId, "Generating transaction...");

    try {
      const phantom = new PhantomDeepLink(this.config.rpcUrl);
      const summary = await phantom.getWalletReclaimSummary(walletAddress);

      if (summary.closable.length === 0) {
        await this.bot.editMessageText("No empty accounts found.", {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        });
        return;
      }

      // Select accounts for this batch
      let accountsToClose: string[];
      if (batchNum !== undefined) {
        accountsToClose = summary.closable.slice(batchNum * 10, (batchNum + 1) * 10).map(a => a.address);
      } else {
        accountsToClose = summary.closable.slice(0, 10).map(a => a.address);
      }

      // Create the transaction
      const tx = await phantom.createCloseAccountsTransaction(
        walletAddress,
        accountsToClose
      );

      const message = `*SIGN TO RECLAIM ${tx.totalSol} SOL*

Closing ${tx.accountCount} empty token account${tx.accountCount > 1 ? "s" : ""}

*Click to sign with your wallet:*

[Open in Phantom](${tx.phantomUrl})

[Open in Solflare](${tx.solflareUrl})

_Opens your mobile wallet app to sign the transaction. The rent will be returned to your wallet._

*Important:*
• Make sure you're signing for the correct wallet
• The transaction will close empty token accounts only
• Rent goes back to YOUR wallet`;

      await this.bot.editMessageText(message, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    } catch (error) {
      await this.bot.editMessageText(`Error: ${(error as Error).message}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
    }
  }

  // --------------------------------------------------------------------------
  // WALLET ADDRESS HANDLERS
  // --------------------------------------------------------------------------

  /**
   * Handle plain text messages - check if they're wallet addresses
   */
  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text?.trim();

    // Skip if no text, is a command, or user not authorized
    if (!text || text.startsWith("/") || !userId || !this.isAuthorized(userId)) {
      return;
    }

    // Check if it looks like a Solana address (32-44 chars, base58)
    if (this.isValidSolanaAddress(text)) {
      await this.analyzeWallet(chatId, text);
    }
  }

  /**
   * Handle /analyze command with optional address
   */
  private async handleAnalyze(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAuthorized(userId)) return;

    const address = match?.[1]?.trim();

    if (!address) {
      await this.bot.sendMessage(
        chatId,
        "Send a Solana wallet address to analyze it.\n\nExample:\n`/analyze 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`\n\nOr just paste any address directly!",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (!this.isValidSolanaAddress(address)) {
      await this.bot.sendMessage(chatId, "Invalid Solana address format. Please check and try again.");
      return;
    }

    await this.analyzeWallet(chatId, address);
  }

  /**
   * Check if string is a valid Solana address
   */
  private isValidSolanaAddress(address: string): boolean {
    // Base58 characters (no 0, O, I, l)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!base58Regex.test(address)) return false;

    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Analyze a wallet address and send detailed results
   */
  private async analyzeWallet(chatId: number, address: string): Promise<void> {
    const loadingMsg = await this.bot.sendMessage(chatId, "Analyzing wallet...");

    try {
      const connection = new Connection(this.config.rpcUrl, "confirmed");
      const pubkey = new PublicKey(address);

      // Get basic account info
      const accountInfo = await connection.getAccountInfo(pubkey);
      const balance = await connection.getBalance(pubkey);

      // Get recent transactions
      const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 10 });

      // Get token accounts
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      // Build response
      let response = `*WALLET ANALYSIS*\n\n`;
      response += `*Address:*\n\`${address}\`\n\n`;
      
      response += `${"─".repeat(30)}\n`;
      response += `*BALANCE*\n`;
      response += `${"─".repeat(30)}\n`;
      response += `SOL: ${formatSol(balance)}\n\n`;

      // Account info
      response += `${"─".repeat(30)}\n`;
      response += `*ACCOUNT INFO*\n`;
      response += `${"─".repeat(30)}\n`;
      if (accountInfo) {
        response += `Owner: \`${accountInfo.owner.toString().slice(0, 12)}...\`\n`;
        response += `Data Size: ${accountInfo.data.length} bytes\n`;
        response += `Executable: ${accountInfo.executable ? "Yes" : "No"}\n`;
        response += `Rent Epoch: ${accountInfo.rentEpoch}\n`;
      } else {
        response += `Status: Empty (no data)\n`;
      }
      response += `\n`;

      // Token accounts
      response += `${"─".repeat(30)}\n`;
      response += `*TOKEN ACCOUNTS (${tokenAccounts.value.length})*\n`;
      response += `${"─".repeat(30)}\n`;
      
      if (tokenAccounts.value.length > 0) {
        let totalRentLocked = 0;
        let emptyTokenAccounts = 0;
        
        for (const ta of tokenAccounts.value.slice(0, 5)) {
          const parsed = ta.account.data.parsed;
          const info = parsed.info;
          const amount = info.tokenAmount.uiAmount || 0;
          const mint = info.mint.slice(0, 8) + "...";
          const rentLamports = ta.account.lamports;
          totalRentLocked += rentLamports;
          
          if (amount === 0) emptyTokenAccounts++;
          
          response += `• ${mint}: ${amount} tokens\n`;
          response += `  Rent: ${formatSol(rentLamports)}\n`;
        }
        
        if (tokenAccounts.value.length > 5) {
          response += `  ... and ${tokenAccounts.value.length - 5} more\n`;
        }
        
        response += `\n*Token Account Summary:*\n`;
        response += `• Total ATAs: ${tokenAccounts.value.length}\n`;
        response += `• Empty ATAs: ${emptyTokenAccounts}\n`;
        response += `• Rent Locked: ${formatSol(totalRentLocked)}\n`;
      } else {
        response += `No token accounts found\n`;
      }
      response += `\n`;

      // Recent transactions
      response += `${"─".repeat(30)}\n`;
      response += `*RECENT ACTIVITY*\n`;
      response += `${"─".repeat(30)}\n`;
      
      if (signatures.length > 0) {
        for (const sig of signatures.slice(0, 5)) {
          const date = sig.blockTime
            ? new Date(sig.blockTime * 1000).toLocaleDateString()
            : "unknown";
          const status = sig.err ? "FAILED" : "OK";
          response += `• ${date} [${status}]\n`;
          response += `  \`${sig.signature.slice(0, 16)}...\`\n`;
        }
        
        if (signatures.length > 5) {
          response += `  ... and ${signatures.length - 5} more\n`;
        }
      } else {
        response += `No recent transactions\n`;
      }

      // Add action buttons
      const keyboard = {
        inline_keyboard: [
          [
            { text: "View on Solscan", url: `https://solscan.io/account/${address}` },
            { text: "View on Explorer", url: `https://explorer.solana.com/address/${address}` },
          ],
          [
            { text: "Analyze as Operator", callback_data: `analyze_operator_${address}` },
          ],
        ],
      };

      await this.bot.editMessageText(response, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });

    } catch (error) {
      await this.bot.editMessageText(
        `Error analyzing wallet: ${(error as Error).message}`,
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
    }
  }

  /**
   * Analyze address as a Kora operator (sponsored accounts analysis)
   */
  private async analyzeAsOperator(chatId: number, address: string): Promise<void> {
    const loadingMsg = await this.bot.sendMessage(chatId, "Analyzing as operator (this may take a moment)...");

    try {
      const connection = new Connection(this.config.rpcUrl, "confirmed");
      const pubkey = new PublicKey(address);

      // Get operator balance
      const balance = await connection.getBalance(pubkey);

      // Get recent signatures to analyze sponsorship patterns
      const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 100 });

      let sponsorshipCount = 0;
      let totalFeesSpent = 0;
      let accountCreations = 0;

      // Analyze transactions for sponsorship patterns
      for (const sigInfo of signatures.slice(0, 20)) {
        try {
          const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (tx && !tx.meta?.err) {
            // Check if this address was fee payer
            const feePayer = tx.transaction.message.accountKeys[0]?.pubkey;
            if (feePayer?.toString() === address) {
              totalFeesSpent += tx.meta?.fee || 0;

              // Look for account creation instructions
              for (const ix of tx.transaction.message.instructions) {
                if ("parsed" in ix) {
                  const parsed = ix.parsed;
                  if (
                    parsed?.type === "createAccount" ||
                    parsed?.type === "create" ||
                    parsed?.type === "createAccountWithSeed"
                  ) {
                    accountCreations++;
                    // Check if beneficiary is different from operator
                    const info = parsed.info;
                    const beneficiary = info?.wallet || info?.newAccount || info?.base;
                    if (beneficiary && beneficiary !== address) {
                      sponsorshipCount++;
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Skip failed transaction fetches
        }
      }

      let response = `*OPERATOR ANALYSIS*\n\n`;
      response += `*Address:*\n\`${address}\`\n\n`;
      
      response += `${"─".repeat(30)}\n`;
      response += `*WALLET STATUS*\n`;
      response += `${"─".repeat(30)}\n`;
      response += `Balance: ${formatSol(balance)}\n\n`;

      response += `${"─".repeat(30)}\n`;
      response += `*SPONSORSHIP ACTIVITY*\n`;
      response += `(Last 100 transactions)\n`;
      response += `${"─".repeat(30)}\n`;
      response += `Total Transactions: ${signatures.length}\n`;
      response += `Account Creations: ${accountCreations}\n`;
      response += `Sponsored (for others): ${sponsorshipCount}\n`;
      response += `Total Fees Paid: ${formatSol(totalFeesSpent)}\n\n`;

      if (sponsorshipCount > 0) {
        const avgRentPerAccount = 2039280; // ATA rent
        const estimatedRentLocked = sponsorshipCount * avgRentPerAccount;
        response += `*Estimated Rent Locked:*\n`;
        response += `~${formatSol(estimatedRentLocked)}\n\n`;
        response += `_Note: This is an estimate based on recent activity._\n`;
      }

      response += `\n*Next Steps:*\n`;
      response += `Use /scan with this as your operator address to get full tracking.`;

      await this.bot.editMessageText(response, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: "Markdown",
      });

    } catch (error) {
      await this.bot.editMessageText(
        `Error: ${(error as Error).message}`,
        { chat_id: chatId, message_id: loadingMsg.message_id }
      );
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

// Run the bot
async function main() {
  const config = loadBotConfig();

  if (!config.telegramToken) {
    console.error("Error: TELEGRAM_BOT_TOKEN not set");
    console.error("Set it via environment variable or in config.json");
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
  console.log(`[${formatTimestamp()}] Operator: ${config.operatorAddress || "Not configured"}`);
  console.log(`[${formatTimestamp()}] RPC: ${config.rpcUrl}`);
  console.log(`[${formatTimestamp()}] Authorized users: ${config.authorizedUsers.length > 0 ? config.authorizedUsers.join(", ") : "All users allowed"}`);

  const bot = new KoraTelegramBot(config);

  console.log(`[${formatTimestamp()}] Bot is running! Send /start to your bot.`);

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

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
