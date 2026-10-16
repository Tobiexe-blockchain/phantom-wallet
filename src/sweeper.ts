import { Wallet } from 'ethers';
import type { Pool } from 'pg';
import { broadcast, ERC20, type Chain } from './chain.js';
import type { AssetConfig, WalletConfig } from './config.js';
import { deriveDepositWallet } from './hd.js';
import type { HotWallet } from './hot.js';
import type { Secret } from './secret.js';

export interface SweepResult {
  swept: number;
  toppedUp: number;
  skipped: number;
}

type SweeperConfig = Pick<WalletConfig, 'assets'> & { mnemonic: Secret };

const NATIVE_GAS = 21_000n;
const WAIT_MS = 120_000;

/**
 * Moves funds from per-user deposit addresses to the hot wallet.
 * An address is only swept when it has a confirmed deposit and nothing still pending, so funds are never
 * moved while a deposit could still be reorganized away.
 */
export class Sweeper {
  constructor(
    private readonly pool: Pool,
    private readonly chain: Chain,
    private readonly hot: HotWallet,
    private readonly cfg: SweeperConfig,
  ) {}

  async sweepAll(): Promise<SweepResult> {
    const out: SweepResult = { swept: 0, toppedUp: 0, skipped: 0 };
    const rows = await this.pool.query(
      `SELECT da.address, da.derivation_index FROM deposit_addresses da
        WHERE EXISTS (SELECT 1 FROM deposits d WHERE d.address = da.address AND d.status = 'confirmed')
          AND NOT EXISTS (SELECT 1 FROM deposits d WHERE d.address = da.address AND d.status = 'pending')
        ORDER BY da.derivation_index`,
    );
    for (const r of rows.rows) {
      const wallet = new Wallet(deriveDepositWallet(this.cfg.mnemonic.reveal(), r.derivation_index).privateKey, this.chain.provider);
      if (wallet.address !== r.address) throw new Error(`Derived key for index ${r.derivation_index} does not match the stored address. Check MNEMONIC.`);
      // Tokens first: gas that is already sitting on the address pays for the token transfer,
      // and whatever ETH is left afterwards is swept last.
      const ordered = [...this.cfg.assets].sort((a, b) => Number(a.type === 'native') - Number(b.type === 'native'));
      for (const asset of ordered) {
        const res = asset.type === 'native' ? await this.sweepNative(wallet, asset) : await this.sweepToken(wallet, asset);
        out.swept += res.swept;
        out.toppedUp += res.toppedUp;
        out.skipped += res.swept + res.toppedUp === 0 ? 1 : 0;
      }
    }
    return out;
  }

  private async sweepNative(wallet: Wallet, asset: AssetConfig) {
    const balance = await this.chain.provider.getBalance(wallet.address);
    const fees = await this.chain.fees();
    const cost = NATIVE_GAS * fees.maxFeePerGas;
    if (balance <= cost || balance - cost < asset.minSweep || balance - cost === 0n) return { swept: 0, toppedUp: 0 };

    const amount = balance - cost;
    const tx = await wallet.sendTransaction({ to: this.hot.address, value: amount, gasLimit: NATIVE_GAS, type: 2, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    await this.chain.provider.waitForTransaction(tx.hash, 1, WAIT_MS);
    await this.record(asset.symbol, wallet.address, amount, tx.hash, 'sweep');
    return { swept: 1, toppedUp: 0 };
  }

  private async sweepToken(wallet: Wallet, asset: AssetConfig) {
    const balance = await this.chain.balanceOf(asset, wallet.address);
    if (balance === 0n || balance < asset.minSweep) return { swept: 0, toppedUp: 0 };

    const data = ERC20.encodeFunctionData('transfer', [this.hot.address, balance]);
    const gas = ((await this.chain.provider.estimateGas({ from: wallet.address, to: asset.address, data })) * 12n) / 10n;
    const fees = await this.chain.fees();
    const needed = gas * fees.maxFeePerGas;
    let toppedUp = 0;

    const have = await this.chain.provider.getBalance(wallet.address);
    if (have < needed) {
      // The deposit address holds tokens but no gas, so the hot wallet pays for the transfer.
      const topUp = needed - have;
      const request = await this.hot.buildTransfer({ symbol: 'NATIVE', type: 'native', decimals: 18, maxPerTx: 0n, dailyLimit: 0n, minSweep: 0n, hotMin: 0n }, wallet.address, topUp, fees);
      const signed = await this.hot.withNonce(async (nonce) => {
        const s = await this.hot.sign(request, nonce);
        await broadcast(this.chain, s.raw);
        return s;
      });
      await this.chain.provider.waitForTransaction(signed.hash, 1, WAIT_MS);
      await this.record('NATIVE', wallet.address, topUp, signed.hash, 'gas_topup');
      toppedUp = 1;
    }

    const tx = await wallet.sendTransaction({ to: asset.address, data, gasLimit: gas, type: 2, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    await this.chain.provider.waitForTransaction(tx.hash, 1, WAIT_MS);
    await this.record(asset.symbol, wallet.address, balance, tx.hash, 'sweep');
    return { swept: 1, toppedUp };
  }

  private async record(asset: string, from: string, amount: bigint, txHash: string, kind: 'sweep' | 'gas_topup'): Promise<void> {
    await this.pool.query('INSERT INTO sweeps(asset, from_address, amount, tx_hash, kind) VALUES ($1, $2, $3::numeric, $4, $5)', [asset, from, amount.toString(), txHash, kind]);
  }

  /** Hot wallet balances and whether each is below its configured minimum. */
  async hotStatus(): Promise<{ address: string; balances: { asset: string; balance: string; low: boolean }[] }> {
    const balances = [];
    for (const asset of this.cfg.assets) {
      const balance = await this.hot.balanceOf(asset);
      balances.push({ asset: asset.symbol, balance: balance.toString(), low: balance < asset.hotMin });
    }
    return { address: this.hot.address, balances };
  }
}
