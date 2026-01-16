import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

export interface SolanaConfig {
  rpcUrl: string;
  commitment: "processed" | "confirmed" | "finalized";
  network: "devnet" | "testnet" | "mainnet-beta";
}

export interface KoraConfig {
  operatorName: string;
  network: "devnet" | "testnet" | "mainnet-beta";
  rpcUrl: string;
  treasuryAddress: string;
  monitoring: {
    enabled: boolean;
    intervalMinutes: number;
    checkAccountStatus: boolean;
    checkRentEligibility: boolean;
  };
  reclaimPolicy: {
    enabled: boolean;
    autoReclaim: boolean;
    minRentToReclaim: number; // in SOL
    maxReclaimPerBatch: number;
  };
  safety: {
    dryRun: boolean;
    requiredApprovals: number;
    minAccountAge: number; // in days
    whitelistMode: boolean;
    whitelist: string[];
    blacklist: string[];
  };
  alerts: {
    enabled: boolean;
    thresholds: {
      largeIdleRent: number; // in SOL
      reclaimSuccess: boolean;
      reclaimFailure: boolean;
    };
  };
}

export interface MonitoringSession {
  startTime: Date;
  accountsChecked: number;
  accountsClosed: number;
  accountsEligible: number;
  reclaimsAttempted: number;
  reclaimsSucceeded: number;
  reclaimsFailed: number;
  totalRentRecovered: number; // in SOL
  totalRentLocked: number; // in SOL
  errors: string[];
}

export interface ReclaimReport {
  timestamp: Date;
  accountAddress: string;
  rentAmount: number; // in SOL
  transactionSignature: string | null;
  status: "success" | "failed" | "skipped";
  reason: string;
  dryRun: boolean;
}

export class Config {
  private config: KoraConfig;

  constructor() {
    const configPath = process.env.CONFIG_PATH || "./config.json";
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `Config file not found at ${configPath}. Please create config.json or set CONFIG_PATH.`
      );
    }

    const rawConfig = fs.readFileSync(configPath, "utf-8");
    this.config = JSON.parse(rawConfig);
  }

  static loadFromEnv(): KoraConfig {
    const config = new Config();
    const safetyConfig = config.get<KoraConfig["safety"]>("safety");
    return {
      operatorName: process.env.OPERATOR_NAME || config.get<string>("operatorName"),
      network: (process.env.NETWORK as KoraConfig["network"]) || config.get<KoraConfig["network"]>("network"),
      rpcUrl: process.env.SOLANA_RPC_URL || config.get<string>("rpcUrl"),
      treasuryAddress:
        process.env.OPERATOR_TREASURY_ADDRESS ||
        config.get<string>("treasuryAddress"),
      monitoring: config.get<KoraConfig["monitoring"]>("monitoring"),
      reclaimPolicy: config.get<KoraConfig["reclaimPolicy"]>("reclaimPolicy"),
      safety: {
        ...safetyConfig,
        dryRun: process.env.DRY_RUN === "true" || safetyConfig.dryRun,
      },
      alerts: config.get<KoraConfig["alerts"]>("alerts"),
    };
  }

  get<T>(key: string): T {
    const keys = key.split(".");
    let value: any = this.config;

    for (const k of keys) {
      value = value[k];
      if (value === undefined) {
        throw new Error(`Config key not found: ${key}`);
      }
    }

    return value;
  }

  getAll(): KoraConfig {
    return this.config;
  }

  validate(): boolean {
    const config = this.config;

    // Validate treasury address using Solana PublicKey
    if (!config.treasuryAddress) {
      throw new Error("Treasury address not configured");
    }

    try {
      new PublicKey(config.treasuryAddress);
    } catch {
      throw new Error("Invalid treasury address: must be a valid Solana public key");
    }

    if (!config.rpcUrl) {
      throw new Error("RPC URL not configured");
    }

    if (config.monitoring.intervalMinutes < 1) {
      throw new Error("Monitor interval must be at least 1 minute");
    }

    if (config.reclaimPolicy.minRentToReclaim < 0) {
      throw new Error("Minimum rent to reclaim cannot be negative");
    }

    return true;
  }
}
