import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import logger from "../logger.js";

/**
 * Wrapper around Solana Web3.js Connection for account and transaction operations
 */
export class SolanaProvider {
  private connection: Connection;
  private payer: Keypair;

  constructor(rpcUrl: string, payerKeypair: Keypair) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.payer = payerKeypair;
  }

  /**
   * Get detailed information about an account
   */
  async getAccountInfo(address: string) {
    try {
      const pubkey = new PublicKey(address);
      const accountInfo = await this.connection.getAccountInfo(pubkey);
      return accountInfo;
    } catch (error) {
      logger.error(`Failed to fetch account info for ${address}`, error as Error);
      return null;
    }
  }

  /**
   * Get account's lamports (SOL balance)
   */
  async getAccountBalance(address: string): Promise<number> {
    try {
      const pubkey = new PublicKey(address);
      const balance = await this.connection.getBalance(pubkey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.error(`Failed to fetch balance for ${address}`, error as Error);
      return 0;
    }
  }

  /**
   * Check if account exists on-chain
   */
  async accountExists(address: string): Promise<boolean> {
    const accountInfo = await this.getAccountInfo(address);
    return accountInfo !== null;
  }

  /**
   * Get multiple accounts in batch
   */
  async getMultipleAccountsInfo(addresses: string[]) {
    try {
      const pubkeys = addresses.map((addr) => new PublicKey(addr));
      const accountInfos = await this.connection.getMultipleAccountsInfo(pubkeys);
      return accountInfos;
    } catch (error) {
      logger.error("Failed to fetch multiple account infos", error as Error);
      return [];
    }
  }

  /**
   * Check if account is rent-exempt
   */
  async isRentExempt(address: string): Promise<boolean> {
    try {
      const accountInfo = await this.getAccountInfo(address);
      if (!accountInfo) return false;

      const minBalance =
        await this.connection.getMinimumBalanceForRentExemption(
          accountInfo.data.length
        );
      return accountInfo.lamports >= minBalance;
    } catch (error) {
      logger.error(`Failed to check rent exemption for ${address}`, error as Error);
      return false;
    }
  }

  /**
   * Calculate minimum balance needed for rent exemption
   */
  async getMinimumBalanceForRentExemption(dataSize: number): Promise<number> {
    try {
      const minBalance =
        await this.connection.getMinimumBalanceForRentExemption(dataSize);
      return minBalance / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.error("Failed to get minimum balance", error as Error);
      return 0;
    }
  }

  /**
   * Close an account and reclaim its rent
   * The account must be empty (no data) and the transaction must be signed by the payer
   */
  async closeAccount(
    accountToClose: PublicKey,
    recipient: PublicKey,
    dryRun: boolean = false
  ): Promise<string | null> {
    try {
      const accountInfo = await this.getAccountInfo(accountToClose.toString());

      if (!accountInfo) {
        throw new Error("Account does not exist");
      }

      // Account must be empty (no data) to close
      if (accountInfo.data.length > 0) {
        throw new Error("Account is not empty. Cannot close.");
      }

      // Build the close instruction
      const instruction = SystemProgram.transfer({
        fromPubkey: accountToClose,
        toPubkey: recipient,
        lamports: accountInfo.lamports,
      });

      // Create a transaction
      const transaction = new Transaction().add(instruction);
      transaction.feePayer = this.payer.publicKey;

      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;

      if (dryRun) {
        logger.info(`[DRY_RUN] Would close account ${accountToClose.toString()}`);
        return null;
      }

      // Sign and send transaction
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.payer]
      );

      logger.info(
        `Successfully closed account ${accountToClose.toString()} | Txn: ${signature}`
      );
      return signature;
    } catch (error) {
      logger.error(
        `Failed to close account ${accountToClose.toString()}`,
        error as Error
      );
      return null;
    }
  }

  /**
   * Get transaction details
   */
  async getTransaction(signature: string) {
    try {
      const transaction = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      return transaction;
    } catch (error) {
      logger.error(`Failed to fetch transaction ${signature}`, error as Error);
      return null;
    }
  }

  /**
   * Get the payer's current balance
   */
  async getPayerBalance(): Promise<number> {
    return this.getAccountBalance(this.payer.publicKey.toString());
  }

  /**
   * Get the payer's address
   */
  getPayerAddress(): string {
    return this.payer.publicKey.toString();
  }
}
