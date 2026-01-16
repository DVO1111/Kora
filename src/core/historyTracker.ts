import * as fs from "fs";
import * as path from "path";
import logger from "../logger.js";
import { ReclaimResult } from "../types.js";

export interface HistoryEntry {
  timestamp: string;
  operatorName: string;
  sessionId: string;
  reclaimsAttempted: number;
  reclaimsSucceeded: number;
  totalReclaimed: number;
  results: ReclaimResult[];
}

/**
 * Tracks reclaim history and provides analytics
 */
export class HistoryTracker {
  private historyFile: string;
  private history: HistoryEntry[];

  constructor(historyFile: string = "./history.json") {
    this.historyFile = historyFile;
    this.history = this.loadHistory();
  }

  /**
   * Load history from file
   */
  private loadHistory(): HistoryEntry[] {
    try {
      if (fs.existsSync(this.historyFile)) {
        const data = fs.readFileSync(this.historyFile, "utf-8");
        return JSON.parse(data);
      }
    } catch (error) {
      logger.warn(`Failed to load history file: ${error}`);
    }
    return [];
  }

  /**
   * Save history to file
   */
  private saveHistory(): void {
    try {
      const data = JSON.stringify(this.history, null, 2);
      fs.writeFileSync(this.historyFile, data);
    } catch (error) {
      logger.error(`Failed to save history file`, error as Error);
    }
  }

  /**
   * Add a new session entry
   */
  addSession(
    operatorName: string,
    results: ReclaimResult[]
  ): void {
    const entry: HistoryEntry = {
      timestamp: new Date().toISOString(),
      operatorName,
      sessionId: this.generateSessionId(),
      reclaimsAttempted: results.length,
      reclaimsSucceeded: results.filter((r) => r.success).length,
      totalReclaimed: results
        .filter((r) => r.success)
        .reduce((sum, r) => sum + (r.rentReclaimed || 0), 0),
      results,
    };

    this.history.push(entry);
    this.saveHistory();

    logger.info(
      `Session ${entry.sessionId} saved: ${entry.reclaimsSucceeded} reclaims, ${entry.totalReclaimed.toFixed(4)} SOL`
    );
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  }

  /**
   * Get all history entries
   */
  getAllHistory(): HistoryEntry[] {
    return this.history;
  }

  /**
   * Get history for a date range
   */
  getHistoryRange(fromDate: Date, toDate: Date): HistoryEntry[] {
    return this.history.filter((entry) => {
      const entryDate = new Date(entry.timestamp);
      return entryDate >= fromDate && entryDate <= toDate;
    });
  }

  /**
   * Get analytics summary
   */
  getAnalytics(fromDate?: Date, toDate?: Date): {
    totalSessions: number;
    totalReclaimsAttempted: number;
    totalReclaimsSucceeded: number;
    totalSolReclaimed: number;
    averageSuccessRate: number;
    averageSolPerSession: number;
    mostRecentSession: HistoryEntry | null;
  } {
    const entries =
      fromDate && toDate
        ? this.getHistoryRange(fromDate, toDate)
        : this.history;

    if (entries.length === 0) {
      return {
        totalSessions: 0,
        totalReclaimsAttempted: 0,
        totalReclaimsSucceeded: 0,
        totalSolReclaimed: 0,
        averageSuccessRate: 0,
        averageSolPerSession: 0,
        mostRecentSession: null,
      };
    }

    const totalReclaimsAttempted = entries.reduce(
      (sum, e) => sum + e.reclaimsAttempted,
      0
    );
    const totalReclaimsSucceeded = entries.reduce(
      (sum, e) => sum + e.reclaimsSucceeded,
      0
    );
    const totalSolReclaimed = entries.reduce(
      (sum, e) => sum + e.totalReclaimed,
      0
    );

    return {
      totalSessions: entries.length,
      totalReclaimsAttempted,
      totalReclaimsSucceeded,
      totalSolReclaimed,
      averageSuccessRate:
        totalReclaimsAttempted > 0
          ? (totalReclaimsSucceeded / totalReclaimsAttempted) * 100
          : 0,
      averageSolPerSession: totalSolReclaimed / entries.length,
      mostRecentSession: entries[entries.length - 1],
    };
  }

  /**
   * Get unique accounts that have been reclaimed
   */
  getReclaimedAccounts(): Set<string> {
    const accounts = new Set<string>();
    for (const entry of this.history) {
      for (const result of entry.results) {
        if (result.success) {
          accounts.add(result.address);
        }
      }
    }
    return accounts;
  }

  /**
   * Check if an account was previously reclaimed
   */
  wasAccountReclaimed(address: string): boolean {
    return this.getReclaimedAccounts().has(address);
  }

  /**
   * Prune old history (older than N days)
   */
  pruneHistory(daysToKeep: number): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const originalLength = this.history.length;
    this.history = this.history.filter((entry) => {
      return new Date(entry.timestamp) >= cutoffDate;
    });

    const pruned = originalLength - this.history.length;
    if (pruned > 0) {
      this.saveHistory();
      logger.info(`Pruned ${pruned} old history entries`);
    }

    return pruned;
  }

  /**
   * Export history as CSV
   */
  exportCsv(): string {
    const headers = [
      "Timestamp",
      "Session ID",
      "Reclaims Attempted",
      "Reclaims Succeeded",
      "Total SOL Reclaimed",
    ];

    const rows = this.history.map((entry) => [
      entry.timestamp,
      entry.sessionId,
      entry.reclaimsAttempted.toString(),
      entry.reclaimsSucceeded.toString(),
      entry.totalReclaimed.toFixed(6),
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${cell}"`).join(","))
      .join("\n");

    return csv;
  }
}
