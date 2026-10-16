import { Transaction, Wallet } from 'ethers';
import type { TransactionRequest } from 'ethers';
import type { Pool } from 'pg';
import { ERC20, type Chain } from './chain.js';
import type { AssetConfig } from './config.js';
import { deriveHotWallet } from './hd.js';

const HOT_NONCE_LOCK = 7_461_001;
const HOT_NATIVE_GAS = 21_000n;

export interface SignedTx {
  raw: string;
  hash: string;
  nonce: number;
  request: TransactionRequest;
}

/** The hot wallet: the only key that signs withdrawals. */
export class HotWallet {
  readonly wallet: Wallet;

  constructor(
    private readonly pool: Pool,
    private readonly chain: Chain,
    mnemonic: string,
  ) {
    this.wallet = new Wallet(deriveHotWallet(mnemonic).privateKey, chain.provider);
  }

  get address(): string {
    return this.wallet.address;
  }

  balanceOf(asset: AssetConfig): Promise<bigint> {
    return this.chain.balanceOf(asset, this.address);
  }

  /** Builds an unsigned transfer without a nonce. Throws if the node says it would revert. */
  async buildTransfer(asset: AssetConfig, to: string, amount: bigint, fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, gasLimit?: bigint): Promise<TransactionRequest> {
    const f = fees ?? (await this.chain.fees());
    const base: TransactionRequest =
      asset.type === 'native'
        ? { to, value: amount }
        : { to: asset.address, value: 0n, data: ERC20.encodeFunctionData('transfer', [to, amount]) };
    const gas = gasLimit ?? (asset.type === 'native' ? HOT_NATIVE_GAS : ((await this.wallet.estimateGas({ ...base, from: this.address })) * 12n) / 10n);
    return { ...base, type: 2, chainId: this.chain.chainId, gasLimit: gas, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
  }

  /**
   * Picks the next nonce while holding a database lock, so two processes never sign two different
   * transactions with the same nonce. The caller must persist the signed transaction and broadcast it
   * before the lock is released.
   */
  async withNonce<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [HOT_NONCE_LOCK]);
      const nonce = await this.chain.provider.getTransactionCount(this.address, 'pending');
      return await fn(nonce);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [HOT_NONCE_LOCK]).catch(() => undefined);
      client.release();
    }
  }

  async sign(request: TransactionRequest, nonce: number): Promise<SignedTx> {
    const withNonce = { ...request, nonce };
    const raw = await this.wallet.signTransaction(withNonce);
    return { raw, hash: Transaction.from(raw).hash!, nonce, request: withNonce };
  }

  /** Gas the hot wallet needs for one transfer of this asset. */
  static gasCost(request: TransactionRequest): bigint {
    return BigInt(request.gasLimit ?? 0n) * BigInt(request.maxFeePerGas ?? 0n);
  }
}
