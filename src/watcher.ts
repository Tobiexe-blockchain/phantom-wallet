import { zeroPadValue } from 'ethers';
import type { Pool } from 'pg';
import { ERC20, TRANSFER_TOPIC, type Chain } from './chain.js';
import type { AssetConfig, WalletConfig } from './config.js';
import type { EventSink } from './events.js';

const STATE_KEY = 'scanned_block';
const WATCH_LOCK = 7_461_002;
const TOPIC_CHUNK = 100;

export interface CycleResult {
  skipped: boolean;
  scannedTo: number;
  found: number;
  confirmed: number;
  orphaned: number;
}

type WatcherConfig = Pick<WalletConfig, 'assets' | 'confirmations' | 'maxBlocksPerScan' | 'startBlock'>;

/**
 * Finds incoming transfers to deposit addresses and reports them once they are buried under enough blocks.
 *
 * Each cycle re-scans the last `confirmations` blocks, so a deposit that was reorganized out and mined again
 * is picked up in its new block. Before a deposit is confirmed, its block hash is compared with the chain,
 * and a deposit whose block disappeared is marked orphaned instead of confirmed.
 */
export class DepositWatcher {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly chain: Chain,
    private readonly cfg: WatcherConfig,
    private readonly sink: EventSink,
  ) {}

  async cycle(): Promise<CycleResult> {
    const lock = await this.pool.connect();
    try {
      const got = (await lock.query('SELECT pg_try_advisory_lock($1) AS ok', [WATCH_LOCK])).rows[0].ok;
      if (!got) return { skipped: true, scannedTo: 0, found: 0, confirmed: 0, orphaned: 0 };
      try {
        return await this.runCycle();
      } finally {
        await lock.query('SELECT pg_advisory_unlock($1)', [WATCH_LOCK]);
      }
    } finally {
      lock.release();
    }
  }

  private async runCycle(): Promise<CycleResult> {
    const head = await this.chain.provider.getBlockNumber();
    let cursor = await this.readCursor();
    if (cursor === null) cursor = this.cfg.startBlock ?? head;
    if (cursor > head) cursor = head; // the chain went backwards (reorg or reset)

    const from = Math.max(0, cursor - this.cfg.confirmations + 1);
    const to = Math.min(head, cursor + this.cfg.maxBlocksPerScan);
    const found = await this.scan(from, to);
    await this.writeCursor(to);

    const { confirmed, orphaned } = await this.confirmDeposits(head);
    await this.deliver();
    return { skipped: false, scannedTo: to, found, confirmed, orphaned };
  }

  private async addressMap(): Promise<Map<string, string>> {
    const res = await this.pool.query('SELECT user_id, address FROM deposit_addresses');
    return new Map(res.rows.map((r) => [String(r.address).toLowerCase(), r.user_id as string]));
  }

  private async scan(from: number, to: number): Promise<number> {
    const addresses = await this.addressMap();
    if (addresses.size === 0 || from > to) return 0;
    let found = 0;

    for (const asset of this.cfg.assets.filter((a) => a.type === 'native')) {
      for (let n = from; n <= to; n++) {
        const block = await this.chain.provider.getBlock(n, true);
        if (!block) continue;
        for (const tx of block.prefetchedTransactions) {
          const user = tx.to ? addresses.get(tx.to.toLowerCase()) : undefined;
          if (!user || tx.value === 0n) continue;
          found += await this.record(user, tx.to!, asset.symbol, tx.value, tx.hash, -1, n, block.hash!);
        }
      }
    }

    const topics = [...addresses.keys()].map((a) => zeroPadValue(a, 32));
    for (const asset of this.cfg.assets.filter((a) => a.type === 'erc20')) {
      for (let i = 0; i < topics.length; i += TOPIC_CHUNK) {
        const logs = await this.chain.provider.getLogs({
          address: asset.address,
          fromBlock: from,
          toBlock: to,
          topics: [TRANSFER_TOPIC, null, topics.slice(i, i + TOPIC_CHUNK)],
        });
        for (const log of logs) {
          const parsed = ERC20.parseLog(log);
          const toAddr = String(parsed!.args[1]);
          const user = addresses.get(toAddr.toLowerCase());
          const amount = BigInt(parsed!.args[2]);
          if (!user || amount === 0n) continue;
          found += await this.record(user, toAddr, asset.symbol, amount, log.transactionHash, log.index, log.blockNumber, log.blockHash);
        }
      }
    }
    return found;
  }

  /** Inserts a deposit, or moves a pending or orphaned one to the block it now sits in. */
  private async record(userId: string, address: string, asset: string, amount: bigint, txHash: string, logIndex: number, blockNumber: number, blockHash: string): Promise<number> {
    const res = await this.pool.query(
      `INSERT INTO deposits(user_id, address, asset, amount, tx_hash, log_index, block_number, block_hash)
       VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8)
       ON CONFLICT (tx_hash, log_index) DO UPDATE
         SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash, status = 'pending'
       WHERE deposits.status IN ('pending', 'orphaned')
         AND (deposits.block_hash IS DISTINCT FROM EXCLUDED.block_hash OR deposits.status = 'orphaned')`,
      [userId, address, asset, amount.toString(), txHash, logIndex, blockNumber, blockHash],
    );
    return res.rowCount ?? 0;
  }

  private async confirmDeposits(head: number): Promise<{ confirmed: number; orphaned: number }> {
    const due = await this.pool.query(`SELECT id, block_number, block_hash FROM deposits WHERE status = 'pending' AND block_number <= $1 ORDER BY id`, [head - this.cfg.confirmations + 1]);
    let confirmed = 0;
    let orphaned = 0;
    for (const d of due.rows) {
      const block = await this.chain.provider.getBlock(Number(d.block_number));
      if (!block || block.hash !== d.block_hash) {
        const upd = await this.pool.query(`UPDATE deposits SET status = 'orphaned' WHERE id = $1 AND status = 'pending'`, [d.id]);
        orphaned += upd.rowCount ?? 0;
        continue;
      }
      // Conditional update: a deposit can only be confirmed once, whoever gets here first.
      const upd = await this.pool.query(`UPDATE deposits SET status = 'confirmed', confirmed_at = now() WHERE id = $1 AND status = 'pending'`, [d.id]);
      confirmed += upd.rowCount ?? 0;
    }
    return { confirmed, orphaned };
  }

  /** Sends every confirmed deposit that has not been delivered yet. A failed delivery is retried next cycle. */
  async deliver(): Promise<number> {
    const rows = await this.pool.query(
      `SELECT id, user_id, asset, amount::text AS amount, address, tx_hash, block_number FROM deposits WHERE status = 'confirmed' AND notified_at IS NULL ORDER BY id LIMIT 100`,
    );
    let sent = 0;
    for (const r of rows.rows) {
      try {
        await this.sink.depositConfirmed({ id: r.id, userId: r.user_id, asset: r.asset, amount: r.amount, address: r.address, txHash: r.tx_hash, blockNumber: Number(r.block_number) });
      } catch (err) {
        console.error(`deposit event ${r.id} not delivered: ${(err as Error).message}`);
        break;
      }
      await this.pool.query('UPDATE deposits SET notified_at = now() WHERE id = $1', [r.id]);
      sent++;
    }
    return sent;
  }

  private async readCursor(): Promise<number | null> {
    const res = await this.pool.query('SELECT value FROM watcher_state WHERE key = $1', [STATE_KEY]);
    return res.rows[0] ? Number(res.rows[0].value) : null;
  }

  private async writeCursor(block: number): Promise<void> {
    await this.pool.query('INSERT INTO watcher_state(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [STATE_KEY, block]);
  }

  start(intervalMs: number): void {
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.cycle();
      } catch (err) {
        console.error(`watcher cycle failed: ${(err as Error).message}`);
      }
      if (this.running) this.timer = setTimeout(tick, intervalMs);
    };
    this.running = true;
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }
}

export type { AssetConfig };
