export interface SponsoredAccount {
  address: string;
  owner: string;
  lamports: number;
  dataSize: number;
  executable: boolean;
  createdAt: Date;
}

export interface RentStatus {
  address: string;
  lamports: number;
  rentAmount: number;
  isRentExempt: boolean;
  isEmpty: boolean;
  isClosed: boolean;
  canReclaim: boolean;
  reason: string;
}

export interface ReclaimResult {
  address: string;
  success: boolean;
  transactionSignature?: string;
  rentReclaimed?: number;
  error?: string;
}

export interface OperatorMetrics {
  timestamp: Date;
  accountsMonitored: number;
  accountsClosed: number;
  accountsEligibleForReclaim: number;
  reclaimsAttempted: number;
  reclaimsSucceeded: number;
  reclaimsFailed: number;
  totalRentLocked: number;
  totalRentReclaimed: number;
  successRate: number;
  nextCheckIn: Date;
}
