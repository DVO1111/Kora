import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import logger from "../logger.js";
import { ReclaimResult, RentStatus } from "../types.js";

/**
 * Handles the actual reclamation of rent from sponsored accounts
 */
export class RentReclaimer {
  private connection: Connection;
  private treasury: PublicKey;
  private payer: Keypair;

  constructor(rpcUrl: string, treasuryAddress: string, payerKeypair: Keypair) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.treasury = new PublicKey(treasuryAddress);
    this.payer = payerKeypair;
  }

  /**
   * Reclaim rent from a single account
   */
  async reclaimFromAccount(
    accountAddress: string,
    dryRun: boolean = true
  ): Promise<ReclaimResult> {
    const address = new PublicKey(accountAddress);
    const startTime = Date.now();

    try {
      // Get account info
      const accountInfo = await this.connection.getAccountInfo(address);

      if (!accountInfo) {
        return {
          address: accountAddress,
          success: false,
          error: "Account not found or already closed",
          amountReclaimed: 0,
          timestamp: new Date(),
        };
      }

      const rentAmount = accountInfo.lamports / LAMPORTS_PER_SOL;

      // Check if it's a token account
      const isTokenAccount = accountInfo.owner.toString() === TOKEN_PROGRAM_ID.toString();

      if (isTokenAccount) {
        return await this.reclaimTokenAccount(address, rentAmount, dryRun);
      } else {
        return await this.reclaimSystemAccount(address, rentAmount, dryRun);
      }
    } catch (error) {
      logger.error(`Failed to reclaim from ${accountAddress}`, error as Error);
      return {
        address: accountAddress,
        success: false,
        error: (error as Error).message,
        amountReclaimed: 0,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Reclaim rent from a token account
   */
  private async reclaimTokenAccount(
    address: PublicKey,
    rentAmount: number,
    dryRun: boolean
  ): Promise<ReclaimResult> {
    try {
      // Verify it's an empty token account
      const tokenAccount = await getAccount(this.connection, address);

      if (tokenAccount.amount > 0n) {
        return {
          address: address.toString(),
          success: false,
          error: "Token account has non-zero balance",
          amountReclaimed: 0,
          timestamp: new Date(),
        };
      }

      // Check if payer is the owner
      if (tokenAccount.owner.toString() !== this.payer.publicKey.toString()) {
        return {
          address: address.toString(),
          success: false,
          error: "Payer is not the token account owner",
          amountReclaimed: 0,
          timestamp: new Date(),
        };
      }

      if (dryRun) {
        logger.info(
          `[DRY RUN] Would close token account ${address.toString()} and reclaim ${rentAmount.toFixed(6)} SOL`
        );
        return {
          address: address.toString(),
          success: true,
          amountReclaimed: rentAmount,
          timestamp: new Date(),
          txSignature: "DRY_RUN_NO_TX",
        };
      }

      // Create close instruction
      const closeIx = createCloseAccountInstruction(
        address,
        this.treasury,
        this.payer.publicKey
      );

      const tx = new Transaction().add(closeIx);
      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [this.payer],
        { commitment: "confirmed" }
      );

      logger.info(
        `Closed token account ${address.toString()}, reclaimed ${rentAmount.toFixed(6)} SOL, tx: ${signature}`
      );

      return {
        address: address.toString(),
        success: true,
        amountReclaimed: rentAmount,
        timestamp: new Date(),
        txSignature: signature,
      };
    } catch (error) {
      if (error instanceof TokenAccountNotFoundError) {
        return {
          address: address.toString(),
          success: false,
          error: "Token account not found",
          amountReclaimed: 0,
          timestamp: new Date(),
        };
      }
      throw error;
    }
  }

  /**
   * Reclaim rent from a system account (empty account)
   */
  private async reclaimSystemAccount(
    address: PublicKey,
    rentAmount: number,
    dryRun: boolean
  ): Promise<ReclaimResult> {
    const accountInfo = await this.connection.getAccountInfo(address);

    if (!accountInfo) {
      return {
        address: address.toString(),
        success: false,
        error: "Account not found",
        amountReclaimed: 0,
        timestamp: new Date(),
      };
    }

    // Check if account has data
    if (accountInfo.data.length > 0 && !this.isEmptyData(accountInfo.data)) {
      return {
        address: address.toString(),
        success: false,
        error: "Account has non-empty data",
        amountReclaimed: 0,
        timestamp: new Date(),
      };
    }

    // Check if payer owns the account
    if (accountInfo.owner.toString() !== this.payer.publicKey.toString() &&
        accountInfo.owner.toString() !== SystemProgram.programId.toString()) {
      return {
        address: address.toString(),
        success: false,
        error: "Cannot close account owned by another program",
        amountReclaimed: 0,
        timestamp: new Date(),
      };
    }

    if (dryRun) {
      logger.info(
        `[DRY RUN] Would close system account ${address.toString()} and reclaim ${rentAmount.toFixed(6)} SOL`
      );
      return {
        address: address.toString(),
        success: true,
        amountReclaimed: rentAmount,
        timestamp: new Date(),
        txSignature: "DRY_RUN_NO_TX",
      };
    }

    // Transfer lamports to treasury
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: address,
        toPubkey: this.treasury,
        lamports: accountInfo.lamports,
      })
    );

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.payer],
      { commitment: "confirmed" }
    );

    logger.info(
      `Closed system account ${address.toString()}, reclaimed ${rentAmount.toFixed(6)} SOL, tx: ${signature}`
    );

    return {
      address: address.toString(),
      success: true,
      amountReclaimed: rentAmount,
      timestamp: new Date(),
      txSignature: signature,
    };
  }

  /**
   * Batch reclaim from multiple accounts
   */
  async batchReclaim(
    accounts: RentStatus[],
    dryRun: boolean = true,
    batchSize: number = 5
  ): Promise<ReclaimResult[]> {
    const results: ReclaimResult[] = [];
    const reclaimable = accounts.filter((a) => a.canReclaim);

    logger.info(
      `Starting batch reclaim: ${reclaimable.length} accounts, dryRun=${dryRun}`
    );

    for (let i = 0; i < reclaimable.length; i += batchSize) {
      const batch = reclaimable.slice(i, i + batchSize);

      for (const account of batch) {
        const result = await this.reclaimFromAccount(account.address, dryRun);
        results.push(result);

        // Small delay between transactions
        if (!dryRun) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }

    const successful = results.filter((r) => r.success);
    const totalReclaimed = successful.reduce(
      (sum, r) => sum + r.amountReclaimed,
      0
    );

    logger.info(
      `Batch reclaim complete: ${successful.length}/${reclaimable.length} successful, ${totalReclaimed.toFixed(6)} SOL reclaimed`
    );

    return results;
  }

  /**
   * Check if data buffer is empty
   */
  private isEmptyData(data: Buffer): boolean {
    return data.every((byte) => byte === 0);
  }
}
