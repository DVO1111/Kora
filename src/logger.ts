import * as winston from "winston";
import * as fs from "fs";
import * as path from "path";

const logsDir = process.env.LOGS_DIR || "./logs";

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logLevel = process.env.LOG_LEVEL || "info";

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.printf(
      (info) =>
        `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`
    )
  ),
  defaultMeta: { service: "kora-rent-reclaim-bot" },
  transports: [
    // Console output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(
          (info) =>
            `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`
        )
      ),
    }),
    // File output - all logs
    new winston.transports.File({
      filename: path.join(logsDir, "bot.log"),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
    // File output - errors only
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 10485760,
      maxFiles: 5,
    }),
  ],
});

export default logger;

export function logSessionStart(
  operatorName: string,
  accountCount: number
): void {
  logger.info(
    `=== Session Start === Operator: ${operatorName} | Monitoring ${accountCount} accounts`
  );
}

export function logAccountStatus(
  address: string,
  status: "OPEN" | "CLOSED" | "EMPTY" | "UNKNOWN" | "ELIGIBLE" | "INELIGIBLE",
  rentAmount?: number
): void {
  const rentStr = rentAmount !== undefined ? ` | Rent: ${rentAmount} SOL` : "";
  logger.info(`Account: ${address} | Status: ${status}${rentStr}`);
}

export function logReclaimAttempt(
  address: string,
  rentAmount: number,
  dryRun: boolean
): void {
  const mode = dryRun ? "[DRY_RUN]" : "[LIVE]";
  logger.info(
    `${mode} Attempting to reclaim ${rentAmount} SOL from account ${address}`
  );
}

export function logReclaimSuccess(
  address: string,
  rentAmount: number,
  txSignature: string,
  dryRun: boolean
): void {
  const mode = dryRun ? "[DRY_RUN]" : "[LIVE]";
  logger.info(
    `${mode} ✓ Successfully reclaimed ${rentAmount} SOL from ${address} | Txn: ${txSignature}`
  );
}

export function logReclaimFailure(
  address: string,
  reason: string,
  dryRun: boolean
): void {
  const mode = dryRun ? "[DRY_RUN]" : "[LIVE]";
  logger.warn(
    `${mode} ✗ Failed to reclaim from ${address} | Reason: ${reason}`
  );
}

export function logSessionEnd(
  accountsChecked: number,
  reclaimsSucceeded: number,
  totalReclaimed: number
): void {
  logger.info(
    `=== Session End === Checked: ${accountsChecked} | Reclaimed: ${reclaimsSucceeded} | Total: ${totalReclaimed} SOL`
  );
}

export function logError(message: string, error?: Error): void {
  if (error) {
    logger.error(`${message} | Error: ${error.message}`, { stack: error.stack });
  } else {
    logger.error(message);
  }
}

export function logWarning(message: string): void {
  logger.warn(message);
}
