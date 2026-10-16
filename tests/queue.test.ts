import { parseEther } from 'ethers';
import { Queue } from 'bullmq';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWithdrawalQueue, QUEUE_NAME, redisOptions, type WithdrawalQueue } from '../src/queue.js';
import { WithdrawalService } from '../src/withdrawals.js';
import { deployToken, ETH, makeEnv, randomAddress, REDIS_URL, resetDb, setupDb, type Env } from './helpers.js';

let pool: Pool;
let token: string;
let env: Env;
let queue: WithdrawalQueue | undefined;
let service: WithdrawalService;

beforeAll(async () => {
  pool = await setupDb();
  token = await deployToken();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  const q = new Queue(QUEUE_NAME, { connection: redisOptions(REDIS_URL) });
  await q.obliterate({ force: true });
  await q.close();
  await resetDb(pool);
});
afterEach(async () => {
  await queue?.close();
  queue = undefined;
  env?.close();
});

function setup(overrides = {}) {
  env = makeEnv(pool, token, overrides);
  service = new WithdrawalService({
    pool,
    chain: env.chain,
    hot: env.hot,
    config: env.cfg,
    whitelist: env.whitelist,
    sink: env.sink,
    enqueue: (id) => queue!.enqueue(id),
  });
  queue = createWithdrawalQueue(env.cfg, service);
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting');
}

const status = async (id: string) => (await pool.query('SELECT status, attempts, error FROM withdrawals WHERE id = $1', [id])).rows[0];

describe('withdrawal queue', () => {
  it('sends a requested withdrawal through the worker', async () => {
    setup();
    await env.fund(env.hot.address, 5n * ETH);
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    const { withdrawal } = await service.request({ userId: 'alice', asset: 'ETH', amount: parseEther('0.3'), to, key: 'q-1' });

    await waitFor(async () => (await status(withdrawal.id)).status === 'broadcast');
    expect(await env.chain.provider.getBalance(to)).toBe(parseEther('0.3'));
    await env.mine(2);
    await service.monitor();
    expect((await status(withdrawal.id)).status).toBe('confirmed');
  });

  it('runs a withdrawal once even if it is queued twice', async () => {
    setup();
    await env.fund(env.hot.address, 5n * ETH);
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    const { withdrawal } = await service.request({ userId: 'alice', asset: 'ETH', amount: parseEther('0.3'), to, key: 'q-2' });
    await queue!.enqueue(withdrawal.id);
    await queue!.enqueue(withdrawal.id);
    await waitFor(async () => (await status(withdrawal.id)).status === 'broadcast');
    await new Promise((r) => setTimeout(r, 500));
    expect(await env.chain.provider.getBalance(to)).toBe(parseEther('0.3'));
    expect((await pool.query('SELECT tx_hashes FROM withdrawals')).rows[0].tx_hashes).toHaveLength(1);
  });

  it('retries while the hot wallet is empty and sends once it is funded', async () => {
    setup({ withdrawalAttempts: 8, retryBackoffMs: 200 });
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    const { withdrawal } = await service.request({ userId: 'alice', asset: 'ETH', amount: parseEther('0.3'), to, key: 'q-3' });
    await waitFor(async () => (await status(withdrawal.id)).attempts >= 1);
    expect((await status(withdrawal.id)).status).toBe('queued');

    await env.fund(env.hot.address, ETH);
    await waitFor(async () => (await status(withdrawal.id)).status === 'broadcast', 30_000);
    expect(await env.chain.provider.getBalance(to)).toBe(parseEther('0.3'));
  });

  it('marks the withdrawal failed when every attempt is used up', async () => {
    setup({ withdrawalAttempts: 2, retryBackoffMs: 100 });
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    const { withdrawal } = await service.request({ userId: 'alice', asset: 'ETH', amount: parseEther('0.3'), to, key: 'q-4' });
    await waitFor(async () => (await status(withdrawal.id)).status === 'failed');
    expect((await status(withdrawal.id)).error).toMatch(/Hot wallet balance too low/);
    expect(await env.chain.provider.getBalance(to)).toBe(0n);
  });

  it('re-queues withdrawals that were saved while the queue was unavailable', async () => {
    setup();
    await env.fund(env.hot.address, 5n * ETH);
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    await pool.query(
      `INSERT INTO withdrawals(user_id, asset, amount, to_address, idempotency_key, request_hash, updated_at) VALUES ('alice', 'ETH', $1::numeric, $2, 'q-5', 'x', now() - interval '5 minutes')`,
      [parseEther('0.2').toString(), to],
    );
    expect(await service.requeueStuck(30)).toBe(1);
    await waitFor(async () => (await pool.query(`SELECT status FROM withdrawals`)).rows[0].status === 'broadcast');
    expect(await env.chain.provider.getBalance(to)).toBe(parseEther('0.2'));
  });
});
