import axios from "axios";
import logger from "../logger.js";
import { ReclaimResult } from "../types.js";

/**
 * Sends alerts via Telegram bot
 */
export class TelegramAlerts {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;

  constructor(botToken?: string, chatId?: string) {
    this.botToken = botToken || process.env.TELEGRAM_BOT_TOKEN || "";
    this.chatId = chatId || process.env.TELEGRAM_CHAT_ID || "";
    this.enabled = !!this.botToken && !!this.chatId;

    if (!this.enabled) {
      logger.warn("Telegram bot not configured");
    }
  }

  /**
   * Send a message to Telegram
   */
  private async sendMessage(message: string): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await axios.post(url, {
        chat_id: this.chatId,
        text: message,
        parse_mode: "Markdown",
      });
      return true;
    } catch (error) {
      logger.error("Failed to send Telegram message", error as Error);
      return false;
    }
  }

  /**
   * Alert on large idle rent amount
   */
  async alertLargeIdleRent(
    totalRent: number,
    accountCount: number
  ): Promise<void> {
    const message = `
🔔 *Large Idle Rent Detected*
- Total Rent Locked: ${totalRent.toFixed(2)} SOL
- Accounts: ${accountCount}
- Action: Review and consider reclaiming eligible accounts
    `.trim();

    await this.sendMessage(message);
  }

  /**
   * Alert on successful reclaim
   */
  async alertReclaimSuccess(
    reclaimsCompleted: number,
    totalReclaimed: number,
    txnSignature?: string
  ): Promise<void> {
    const txnLink = txnSignature
      ? `[View Txn](https://solscan.io/tx/${txnSignature})`
      : "";
    const message = `
✅ *Rent Reclaim Successful*
- Accounts Reclaimed: ${reclaimsCompleted}
- Total SOL Recovered: ${totalReclaimed.toFixed(2)} SOL
${txnLink}
    `.trim();

    await this.sendMessage(message);
  }

  /**
   * Alert on reclaim failure
   */
  async alertReclaimFailure(error: string): Promise<void> {
    const message = `
❌ *Rent Reclaim Failed*
- Error: ${error}
- Action: Check logs for details
    `.trim();

    await this.sendMessage(message);
  }

  /**
   * Daily summary alert
   */
  async alertDailySummary(
    accountsMonitored: number,
    accountsClosed: number,
    totalReclaimed: number
  ): Promise<void> {
    const message = `
📊 *Daily Rent Reclaim Summary*
- Accounts Monitored: ${accountsMonitored}
- Accounts Closed: ${accountsClosed}
- Total SOL Reclaimed: ${totalReclaimed.toFixed(2)} SOL
- Timestamp: ${new Date().toISOString()}
    `.trim();

    await this.sendMessage(message);
  }

  /**
   * Check if Telegram is configured
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Session reporter that generates JSON/CSV reports
 */
export class SessionReporter {
  /**
   * Generate JSON report
   */
  static generateJsonReport(
    operatorName: string,
    startTime: Date,
    endTime: Date,
    accountsMonitored: number,
    results: ReclaimResult[]
  ): any {
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const totalReclaimed = successful.reduce(
      (sum, r) => sum + (r.rentReclaimed || 0),
      0
    );

    return {
      metadata: {
        operator: operatorName,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        durationMs: endTime.getTime() - startTime.getTime(),
      },
      summary: {
        accountsMonitored,
        reclaimsAttempted: results.length,
        reclaimsSucceeded: successful.length,
        reclaimsFailed: failed.length,
        successRate:
          ((successful.length / results.length) * 100).toFixed(2) + "%",
        totalSolReclaimed: totalReclaimed,
      },
      results: {
        successful: successful.map((r) => ({
          account: r.address,
          rentReclaimed: r.rentReclaimed,
          txnSignature: r.transactionSignature,
        })),
        failed: failed.map((r) => ({
          account: r.address,
          error: r.error,
        })),
      },
    };
  }

  /**
   * Generate CSV report
   */
  static generateCsvReport(
    operatorName: string,
    startTime: Date,
    endTime: Date,
    results: ReclaimResult[]
  ): string {
    const headers = [
      "Timestamp",
      "Account",
      "Status",
      "Rent Reclaimed (SOL)",
      "Transaction",
      "Error",
    ];

    const rows = results.map((r) => [
      new Date().toISOString(),
      r.address,
      r.success ? "SUCCESS" : "FAILED",
      r.rentReclaimed?.toString() || "N/A",
      r.transactionSignature || "N/A",
      r.error || "N/A",
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${cell}"`).join(","))
      .join("\n");

    return csv;
  }

  /**
   * Generate HTML report
   */
  static generateHtmlReport(
    operatorName: string,
    startTime: Date,
    endTime: Date,
    accountsMonitored: number,
    results: ReclaimResult[]
  ): string {
    const jsonReport = this.generateJsonReport(
      operatorName,
      startTime,
      endTime,
      accountsMonitored,
      results
    );

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Kora Rent Reclaim Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .header { background: #f0f0f0; padding: 20px; border-radius: 8px; }
    .summary { margin: 20px 0; display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
    .metric { background: #f9f9f9; padding: 15px; border-radius: 8px; border-left: 4px solid #007bff; }
    .metric-label { font-weight: bold; color: #666; }
    .metric-value { font-size: 24px; color: #007bff; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
    th { background: #007bff; color: white; }
    tr:nth-child(even) { background: #f9f9f9; }
    .success { color: green; }
    .failed { color: red; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Kora Rent Reclaim Report</h1>
    <p>Operator: <strong>${operatorName}</strong></p>
    <p>Generated: ${new Date().toISOString()}</p>
  </div>

  <div class="summary">
    <div class="metric">
      <div class="metric-label">Accounts Monitored</div>
      <div class="metric-value">${accountsMonitored}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Reclaims Attempted</div>
      <div class="metric-value">${jsonReport.summary.reclaimsAttempted}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Reclaims Succeeded</div>
      <div class="metric-value" style="color: green;">${jsonReport.summary.reclaimsSucceeded}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Reclaims Failed</div>
      <div class="metric-value" style="color: red;">${jsonReport.summary.reclaimsFailed}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Success Rate</div>
      <div class="metric-value">${jsonReport.summary.successRate}</div>
    </div>
    <div class="metric">
      <div class="metric-label">Total SOL Reclaimed</div>
      <div class="metric-value" style="color: #28a745;">${jsonReport.summary.totalSolReclaimed.toFixed(4)}</div>
    </div>
  </div>

  <h2>Successful Reclaims</h2>
  <table>
    <tr>
      <th>Account</th>
      <th>Rent Reclaimed (SOL)</th>
      <th>Transaction</th>
    </tr>
    ${jsonReport.results.successful
      .map(
        (r: any) => `
    <tr>
      <td>${r.account}</td>
      <td>${r.rentReclaimed?.toFixed(4) || "N/A"}</td>
      <td><a href="https://solscan.io/tx/${r.txnSignature}" target="_blank">${r.txnSignature?.substring(0, 8)}...</a></td>
    </tr>
    `
      )
      .join("")}
  </table>

  <h2>Failed Reclaims</h2>
  <table>
    <tr>
      <th>Account</th>
      <th>Error</th>
    </tr>
    ${jsonReport.results.failed
      .map(
        (r: any) => `
    <tr>
      <td>${r.account}</td>
      <td class="failed">${r.error}</td>
    </tr>
    `
      )
      .join("")}
  </table>
</body>
</html>
    `;

    return html;
  }
}
