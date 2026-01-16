import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  TransactionConfirmationStrategy,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import logger from "../logger.js";
import { sleep, retryWithBackoff } from "../utils/helpers.js";
import { TX_FEES, RATE_LIMITS } from "../utils/constants.js";

export interface TransactionResult {
  success: boolean;
  signature?: string;
  error?: string;
  lamportsRecovered?: number;
}

/**
 * Builds and sends transactions for rent reclaim operations
 */
export class TransactionBuilder {
  private connection: Connection;
  private payer: Keypair;
  private priorityFee: number;

  constructor(
    connection: Connection,
    payer: Keypair,
    priorityFee: number = TX_FEES.PRIORITY_FEE_MICROLAMPORTS
  ) {
    this.connection = connection;
    this.payer = payer;
    this.priorityFee = priorityFee;
  }

  /**
   * Build a transaction to close a system account and reclaim rent
   */
  async buildCloseSystemAccountTx(
    accountToClose: PublicKey,
    recipient: PublicKey
  ): Promise<Transaction | null> {
    try {
      const accountInfo = await this.connection.getAccountInfo(accountToClose);
      if (!accountInfo) {
        logger.warn(`Account ${accountToClose.toString()} does not exist`);
        return null;
      }

      if (accountInfo.data.length > 0) {
        logger.warn(`Account ${accountToClose.toString()} has data, cannot close`);
        return null;
      }

      const tx = new Transaction();

      // Add priority fee (optional, helps with congestion)
      if (this.priorityFee > 0) {
        tx.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: this.priorityFee,
          })
        );
      }

      // Transfer all lamports to close the account
      tx.add(
        SystemProgram.transfer({
          fromPubkey: accountToClose,
          toPubkey: recipient,
          lamports: accountInfo.lamports,
        })
      );

      return tx;
    } catch (error) {
      logger.error(
        `Error building close tx for ${accountToClose.toString()}`,
        error as Error
      );
      return null;
    }
  }

  /**
   * Build a transaction to close a token account and reclaim rent
   */
  async buildCloseTokenAccountTx(
    tokenAccount: PublicKey,
    owner: PublicKey,
    recipient: PublicKey
  ): Promise<Transaction | null> {
    try {
      // Verify the token account exists and is empty
      try {
        const account = await getAccount(this.connection, tokenAccount);
        if (account.amount > 0n) {
          logger.warn(
            `Token account ${tokenAccount.toString()} has balance, cannot close`
          );
          return null;
        }
      } catch (error) {
        if (error instanceof TokenAccountNotFoundError) {
          logger.warn(`Token account ${tokenAccount.toString()} not found`);
          return null;
        }
        throw error;
      }

      const tx = new Transaction();

      // Add priority fee
      if (this.priorityFee > 0) {
        tx.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: this.priorityFee,
          })
        );
      }

      // Close the token account
      tx.add(
        createCloseAccountInstruction(
          tokenAccount,
          recipient,
          owner,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      return tx;
    } catch (error) {
      logger.error(
        `Error building close token tx for ${tokenAccount.toString()}`,
        error as Error
      );
      return null;
    }
  }

  /**
   * Send and confirm a transaction with retry logic
   */
  async sendTransaction(
    transaction: Transaction,
    signers: Keypair[] = []
  ): Promise<TransactionResult> {
    try {
      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      transaction.feePayer = this.payer.publicKey;

      // Sign with all signers
      const allSigners = [this.payer, ...signers];

      // Send with retry
      const signature = await retryWithBackoff(
        async () => {
          return await sendAndConfirmTransaction(
            this.connection,
            transaction,
            allSigners,
            {
              commitment: "confirmed",
              maxRetries: RATE_LIMITS.MAX_RETRIES,
            }
          );
        },
        RATE_LIMITS.MAX_RETRIES,
        RATE_LIMITS.RETRY_DELAY_MS
      );

      logger.info(`Transaction confirmed: ${signature}`);

      return {
        success: true,
        signature,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Transaction failed: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Close a system account and return rent to recipient
   */
  async closeSystemAccount(
    accountToClose: PublicKey,
    recipient: PublicKey,
    dryRun: boolean = false
  ): Promise<TransactionResult> {
    const tx = await this.buildCloseSystemAccountTx(accountToClose, recipient);

    if (!tx) {
      return {
        success: false,
        error: "Failed to build transaction",
      };
    }

    if (dryRun) {
      const accountInfo = await this.connection.getAccountInfo(accountToClose);
      return {
        success: true,
        signature: "[DRY_RUN]",
        lamportsRecovered: accountInfo?.lamports || 0,
      };
    }

    return this.sendTransaction(tx);
  }

  /**
   * Close a token account and return rent to recipient
   */
  async closeTokenAccount(
    tokenAccount: PublicKey,
    owner: Keypair,
    recipient: PublicKey,
    dryRun: boolean = false
  ): Promise<TransactionResult> {
    const tx = await this.buildCloseTokenAccountTx(
      tokenAccount,
      owner.publicKey,
      recipient
    );

    if (!tx) {
      return {
        success: false,
        error: "Failed to build transaction",
      };
    }

    if (dryRun) {
      const accountInfo = await this.connection.getAccountInfo(tokenAccount);
      return {
        success: true,
        signature: "[DRY_RUN]",
        lamportsRecovered: accountInfo?.lamports || 0,
      };
    }

    return this.sendTransaction(tx, [owner]);
  }

  /**
   * Batch close multiple accounts (rate-limited)
   */
  async batchCloseAccounts(
    accounts: Array<{
      address: PublicKey;
      type: "system" | "token";
      owner?: Keypair;
    }>,
    recipient: PublicKey,
    dryRun: boolean = false
  ): Promise<TransactionResult[]> {
    const results: TransactionResult[] = [];

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];

      let result: TransactionResult;
      if (account.type === "token" && account.owner) {
        result = await this.closeTokenAccount(
          account.address,
          account.owner,
          recipient,
          dryRun
        );
      } else {
        result = await this.closeSystemAccount(
          account.address,
          recipient,
          dryRun
        );
      }

      results.push(result);

      // Rate limiting between transactions
      if (i < accounts.length - 1) {
        await sleep(RATE_LIMITS.BATCH_DELAY_MS);
      }
    }

    return results;
  }

  /**
   * Get estimated transaction fee
   */
  getEstimatedFee(): number {
    return TX_FEES.LAMPORTS_PER_SIGNATURE / LAMPORTS_PER_SOL;
  }

  /**
   * Check if payer has sufficient balance
   */
  async hassufficientBalance(requiredLamports: number): Promise<boolean> {
    const balance = await this.connection.getBalance(this.payer.publicKey);
    return balance >= requiredLamports + TX_FEES.LAMPORTS_PER_SIGNATURE;
  }
}
