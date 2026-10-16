import { createHash } from 'node:crypto';
import { getAddress, Transaction, ZeroAddress } from 'ethers';
import type { Pool } from 'pg';
import { broadcast, type Chain } from './chain.js';
import type { AssetConfig, WalletConfig } from './config.js';
import { withTx } from './db.js';
import { AppError, RetryableError } from './errors.js';
import type { EventSink } from './events.js';
import { HotWallet } from './hot.js';
import type { WhitelistChecker } from './whitelist.js';

export type WithdrawalStatus = 'queued' | 'broadcasting' | 'broadcast' | 'confirmed' | 'failed';

export interface Withdrawal {
  id: string;
  userId: string;
  asset: string;
  amount: string;
  to: string;
  status: WithdrawalStatus;
  txHash: string | null;
  txHashes: string[];
  nonce: number | null;
  gasBumps: number;
  attempts: number;
  error: string | null;
  createdAt: string;
}

const COLS = `id, user_id, asset, amount::text AS amount, to_address, status, tx_hash, tx_hashes, nonce, gas_bumps, attempts, error, created_at`;
const toWithdrawal = (r: any): Withdrawal => ({
  id: r.id,
  userId: r.user_id,
  asset: r.asset,
  amount: r.amount,
  to: r.to_address,
  status: r.status,
  txHash: r.tx_hash,
  txHashes: r.tx_hashes,
  nonce: r.nonce === null ? null : Number(r.nonce),
  gasBumps: r.gas_bumps,
  attempts: r.attempts,
  error: r.error,
  createdAt: r.created_at.toISOString(),
});

type ServiceConfig = Pick<WalletConfig, 'assets' | 'confirmations' | 'bumpAfterSec' | 'bumpFactorPct' | 'maxBumps'>;

export interface WithdrawalDeps {
  pool: Pool;
  chain: Chain;
  hot: HotWallet;
  config: ServiceConfig;
  whitelist: WhitelistChecker;
  sink: EventSink;
  /** Puts a withdrawal on the queue. Must be safe to call twice for the same id. */
  enqueue: (id: string) => Promise<void>;
}

const hashRequest = (o: Record<string, string>) => createHash('sha256').update(JSON.stringify(Object.entries(o).sort())).digest('hex');

export class WithdrawalService {
  private readonly assets = new Map<string, AssetConfig>();

  constructor(private readonly d: WithdrawalDeps) {
    for (const a of d.config.assets) this.assets.set(a.symbol, a);
  }

  // ---------- intake ----------

  async request(p: { userId: string; asset: string; amount: bigint; to: string; key: string }): Promise<{ withdrawal: Withdrawal; replayed: boolean }> {
    const asset = this.assets.get(p.asset);
    if (!asset) throw new AppError(400, 'UNKNOWN_ASSET', `Asset ${p.asset} is not supported.`);
    if (p.amount <= 0n) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be greater than 0.');

    let to: string;
    try {
      to = getAddress(p.to); // throws on a bad checksum
    } catch {
      throw new AppError(400, 'INVALID_ADDRESS', 'That is not a valid address, or its checksum is wrong.');
    }
    if (to === ZeroAddress) throw new AppError(400, 'INVALID_ADDRESS', 'Cannot withdraw to the zero address.');
    if (to === this.d.hot.address || [...this.assets.values()].some((a) => a.address === to)) {
      throw new AppError(400, 'INVALID_ADDRESS', 'Cannot withdraw to a contract or wallet this service controls.');
    }
    if (!(await this.d.whitelist.isAllowed(p.userId, 'ethereum', to))) {
      throw new AppError(403, 'NOT_WHITELISTED', 'This address is not on the withdrawal whitelist or is still in its cooling-off period.');
    }
    if (p.amount > asset.maxPerTx) throw new AppError(422, 'LIMIT_PER_TX', 'Amount is above the per-withdrawal limit.', { max: asset.maxPerTx.toString() });

    const requestHash = hashRequest({ userId: p.userId, asset: p.asset, amount: p.amount.toString(), to });
    const result = await withTx(this.d.pool, async (c) => {
      // Serializes this user's requests, so parallel requests cannot all pass the daily limit check.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`withdrawal:${p.userId}`]);

      const existing = await c.query(`SELECT ${COLS}, request_hash FROM withdrawals WHERE idempotency_key = $1`, [p.key]);
      if (existing.rowCount) {
        if (existing.rows[0].request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_MISMATCH', 'This idempotency key was already used with a different request.');
        return { withdrawal: toWithdrawal(existing.rows[0]), replayed: true };
      }

      const used = await c.query(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM withdrawals
          WHERE user_id = $1 AND asset = $2 AND status <> 'failed' AND created_at > now() - interval '24 hours'`,
        [p.userId, p.asset],
      );
      if (BigInt(used.rows[0].total) + p.amount > asset.dailyLimit) {
        throw new AppError(422, 'DAILY_LIMIT', 'This would go over the 24 hour withdrawal limit.', { limit: asset.dailyLimit.toString(), used: used.rows[0].total });
      }

      const ins = await c.query(
        `INSERT INTO withdrawals(user_id, asset, amount, to_address, idempotency_key, request_hash)
         VALUES ($1, $2, $3::numeric, $4, $5, $6) RETURNING ${COLS}`,
        [p.userId, p.asset, p.amount.toString(), to, p.key, requestHash],
      );
      return { withdrawal: toWithdrawal(ins.rows[0]), replayed: false };
    });

    if (!result.replayed) {
      // If the queue is down the row stays 'queued' and requeueStuck() picks it up later.
      await this.d.enqueue(result.withdrawal.id).catch((err) => console.error(`enqueue ${result.withdrawal.id} failed: ${err.message}`));
    }
    return result;
  }

  async get(id: string): Promise<Withdrawal | null> {
    const res = await this.d.pool.query(`SELECT ${COLS} FROM withdrawals WHERE id = $1`, [id]);
    return res.rows[0] ? toWithdrawal(res.rows[0]) : null;
  }

  // ---------- sending ----------

  /**
   * Signs and broadcasts one withdrawal. Safe to run again for the same id: once a signed transaction has
   * been saved, later runs only re-send that same transaction and never sign a second one.
   */
  async process(id: string, ctx: { attempt: number; maxAttempts: number } = { attempt: 1, maxAttempts: 1 }): Promise<void> {
    const claimed = await this.d.pool.query(
      `UPDATE withdrawals SET status = 'broadcasting', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status IN ('queued', 'broadcasting') RETURNING id, user_id, asset, amount::text AS amount, to_address, raw_tx`,
      [id],
    );
    if (claimed.rowCount === 0) return; // already sent, finished, or failed
    const row = claimed.rows[0];

    if (row.raw_tx) {
      await broadcast(this.d.chain, row.raw_tx);
      await this.d.pool.query(`UPDATE withdrawals SET status = 'broadcast', updated_at = now() WHERE id = $1 AND status = 'broadcasting'`, [id]);
      return;
    }

    const asset = this.assets.get(row.asset)!;
    const amount = BigInt(row.amount);

    let request;
    try {
      request = await this.d.hot.buildTransfer(asset, row.to_address, amount);
    } catch (err) {
      await this.markFailed(id, `Transaction would fail: ${(err as Error).message.slice(0, 200)}`);
      return;
    }

    const needNative = HotWallet.gasCost(request) + (asset.type === 'native' ? amount : 0n);
    const lowNative = (await this.d.chain.provider.getBalance(this.d.hot.address)) < needNative;
    const lowAsset = asset.type === 'erc20' && (await this.d.hot.balanceOf(asset)) < amount;
    if (lowNative || lowAsset) {
      if (ctx.attempt >= ctx.maxAttempts) {
        await this.markFailed(id, 'Hot wallet balance too low');
        return;
      }
      await this.d.pool.query(`UPDATE withdrawals SET status = 'queued', updated_at = now() WHERE id = $1 AND status = 'broadcasting'`, [id]);
      throw new RetryableError('Hot wallet balance too low');
    }

    await this.d.hot.withNonce(async (nonce) => {
      // Re-check under the lock: another worker may have signed this withdrawal while we waited.
      const again = await this.d.pool.query('SELECT raw_tx FROM withdrawals WHERE id = $1', [id]);
      if (again.rows[0].raw_tx) return broadcast(this.d.chain, again.rows[0].raw_tx);

      const signed = await this.d.hot.sign(request, nonce);
      // Persist before broadcasting: if we crash after this, a retry re-sends this exact transaction.
      await this.d.pool.query(
        `UPDATE withdrawals SET nonce = $2, raw_tx = $3, tx_hash = $4, tx_hashes = ARRAY[$4]::text[], gas_limit = $5::numeric,
                max_fee = $6::numeric, priority_fee = $7::numeric, last_sent_at = now(), updated_at = now() WHERE id = $1`,
        [id, nonce, signed.raw, signed.hash, String(request.gasLimit), String(request.maxFeePerGas), String(request.maxPriorityFeePerGas)],
      );
      await broadcast(this.d.chain, signed.raw);
    });
    await this.d.pool.query(`UPDATE withdrawals SET status = 'broadcast', updated_at = now() WHERE id = $1 AND status = 'broadcasting'`, [id]);
  }

  /** Only withdrawals that are not on the network yet can be failed here. A broadcast one may still be mined. */
  async markFailed(id: string, reason: string): Promise<void> {
    await this.d.pool.query(
      `UPDATE withdrawals SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status IN ('queued', 'broadcasting') AND raw_tx IS NULL`,
      [id, reason],
    );
  }

  // ---------- following transactions to the end ----------

  /** Checks every broadcast withdrawal: confirms it, fails it, or replaces a stuck transaction with a higher fee. */
  async monitor(): Promise<{ confirmed: number; failed: number; bumped: number }> {
    const out = { confirmed: 0, failed: 0, bumped: 0 };
    await this.recoverStuckBroadcasts();
    const rows = await this.d.pool.query(`SELECT ${COLS}, to_address, gas_limit::text AS gas_limit, max_fee::text AS max_fee, priority_fee::text AS priority_fee,
                                                 EXTRACT(EPOCH FROM (now() - last_sent_at))::int AS age_sec FROM withdrawals WHERE status = 'broadcast' ORDER BY created_at`);
    const head = await this.d.chain.provider.getBlockNumber();

    for (const row of rows.rows) {
      const w = toWithdrawal(row);
      // Read the chain nonce BEFORE the receipts, so a transaction mined in between is never mistaken for a lost nonce.
      const chainNonce = await this.d.chain.provider.getTransactionCount(this.d.hot.address, 'latest');
      let mined: { hash: string; status: number | null; block: number } | null = null;
      for (const hash of [...w.txHashes].reverse()) {
        const r = await this.d.chain.provider.getTransactionReceipt(hash);
        if (r) {
          mined = { hash, status: r.status, block: r.blockNumber };
          break;
        }
      }

      if (mined) {
        if (mined.status === 0) {
          await this.finish(w.id, 'failed', mined.hash, mined.block, 'The transaction reverted on chain.');
          out.failed++;
        } else if (head - mined.block + 1 >= this.d.config.confirmations) {
          await this.finish(w.id, 'confirmed', mined.hash, mined.block, null);
          out.confirmed++;
        }
        continue;
      }
      if (w.nonce !== null && chainNonce > w.nonce) {
        await this.finish(w.id, 'failed', null, null, 'The nonce was used by a different transaction. Needs manual review.');
        out.failed++;
        continue;
      }
      if (row.age_sec >= this.d.config.bumpAfterSec && w.gasBumps < this.d.config.maxBumps) {
        await this.bump(row);
        out.bumped++;
      }
    }
    return out;
  }

  /** A transaction saved but never confirmed as sent (for example the process died): send it again. Safe, it is the same transaction. */
  private async recoverStuckBroadcasts(): Promise<void> {
    const stuck = await this.d.pool.query(`SELECT id, raw_tx FROM withdrawals WHERE status = 'broadcasting' AND raw_tx IS NOT NULL AND updated_at < now() - interval '60 seconds'`);
    for (const r of stuck.rows) {
      await broadcast(this.d.chain, r.raw_tx);
      await this.d.pool.query(`UPDATE withdrawals SET status = 'broadcast', updated_at = now() WHERE id = $1 AND status = 'broadcasting'`, [r.id]);
    }
  }

  /** Replaces a stuck transaction: same nonce, same payload, higher fees. Only one of the two can ever be mined. */
  private async bump(row: any): Promise<void> {
    const asset = this.assets.get(row.asset)!;
    const factor = BigInt(this.d.config.bumpFactorPct);
    const now = await this.d.chain.fees();
    const bigger = (prev: string, current: bigint) => {
      const raised = (BigInt(prev) * factor + 99n) / 100n;
      return raised > current ? raised : current;
    };
    const maxFee = bigger(row.max_fee, now.maxFeePerGas);
    const priority = bigger(row.priority_fee, now.maxPriorityFeePerGas);

    const request = await this.d.hot.buildTransfer(asset, row.to_address, BigInt(row.amount), { maxFeePerGas: maxFee < priority ? priority : maxFee, maxPriorityFeePerGas: priority }, BigInt(row.gas_limit));
    const signed = await this.d.hot.sign(request, Number(row.nonce));
    await this.d.pool.query(
      `UPDATE withdrawals SET raw_tx = $2, tx_hash = $3, tx_hashes = array_append(tx_hashes, $3), max_fee = $4::numeric, priority_fee = $5::numeric,
              gas_bumps = gas_bumps + 1, last_sent_at = now(), updated_at = now() WHERE id = $1 AND status = 'broadcast'`,
      [row.id, signed.raw, signed.hash, String(request.maxFeePerGas), String(request.maxPriorityFeePerGas)],
    );
    await broadcast(this.d.chain, signed.raw);
  }

  private async finish(id: string, status: 'confirmed' | 'failed', txHash: string | null, block: number | null, error: string | null): Promise<void> {
    await this.d.pool.query(
      `UPDATE withdrawals SET status = $2, tx_hash = COALESCE($3, tx_hash), block_number = $4, error = $5, updated_at = now() WHERE id = $1 AND status = 'broadcast'`,
      [id, status, txHash, block, error],
    );
  }

  /** Delivers final outcomes to the event sink. Retried until accepted. */
  async deliver(): Promise<number> {
    const rows = await this.d.pool.query(
      `SELECT id, user_id, asset, amount::text AS amount, to_address, status, tx_hash, error FROM withdrawals WHERE status IN ('confirmed', 'failed') AND notified_at IS NULL ORDER BY updated_at LIMIT 100`,
    );
    let sent = 0;
    for (const r of rows.rows) {
      try {
        await this.d.sink.withdrawalFinalized({ id: r.id, userId: r.user_id, asset: r.asset, amount: r.amount, to: r.to_address, status: r.status, txHash: r.tx_hash, error: r.error });
      } catch (err) {
        console.error(`withdrawal event ${r.id} not delivered: ${(err as Error).message}`);
        break;
      }
      await this.d.pool.query('UPDATE withdrawals SET notified_at = now() WHERE id = $1', [r.id]);
      sent++;
    }
    return sent;
  }

  /** Re-queues withdrawals that were saved but never reached the queue (for example, Redis was down). */
  async requeueStuck(olderThanSec = 30): Promise<number> {
    const rows = await this.d.pool.query(`SELECT id FROM withdrawals WHERE status = 'queued' AND updated_at < now() - make_interval(secs => $1)`, [olderThanSec]);
    for (const r of rows.rows) await this.d.enqueue(r.id);
    return rows.rowCount ?? 0;
  }

  /** Whether the transaction we hold for a withdrawal decodes to what we expect. Used by tests and audits. */
  static decode(raw: string) {
    return Transaction.from(raw);
  }
}
