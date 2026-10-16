import { getAddress, parseEther, Transaction, ZeroAddress } from 'ethers';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RetryableError } from '../src/errors.js';
import type { EventSink, WithdrawalEvent } from '../src/events.js';
import { deployToken, ETH, ETH_ADDRESS, makeEnv, randomAddress, resetDb, setupDb, type Env } from './helpers.js';

let pool: Pool;
let token: string;
let env: Env;
beforeAll(async () => {
  pool = await setupDb();
  token = await deployToken();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  env = makeEnv(pool, token);
});
afterEach(async () => {
  await env.setAutomine(true);
  env.close();
});

let keySeq = 0;
const key = () => `k-${Date.now()}-${++keySeq}`;

async function request(asset = 'ETH', amount = parseEther('0.3'), user = 'alice', to = randomAddress()) {
  env.whitelist.allow(user, to);
  const r = await env.withdrawals.request({ userId: user, asset, amount, to, key: key() });
  return { ...r, to };
}
const row = async (id: string) => (await pool.query('SELECT * FROM withdrawals WHERE id = $1', [id])).rows[0];

describe('requesting a withdrawal', () => {
  it('accepts a valid request and queues it', async () => {
    const r = await request();
    expect(r.replayed).toBe(false);
    expect(r.withdrawal).toMatchObject({ status: 'queued', asset: 'ETH', amount: parseEther('0.3').toString() });
    expect(env.queued).toEqual([r.withdrawal.id]);
  });

  it('rejects bad addresses, including a wrong checksum and addresses the service controls', async () => {
    const send = (to: string) => env.withdrawals.request({ userId: 'alice', asset: 'ETH', amount: 1n, to, key: key() });
    for (const to of ['not-an-address', '0x123', ETH_ADDRESS.replace('9EE7', '9Ee7'), ZeroAddress, token, env.hot.address]) {
      await expect(send(to), to).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    }
  });

  it('requires the address to be on the whitelist', async () => {
    await expect(env.withdrawals.request({ userId: 'alice', asset: 'ETH', amount: 1n, to: randomAddress(), key: key() })).rejects.toMatchObject({ code: 'NOT_WHITELISTED', status: 403 });
    const to = randomAddress();
    env.whitelist.allow('bob', to);
    await expect(env.withdrawals.request({ userId: 'alice', asset: 'ETH', amount: 1n, to, key: key() })).rejects.toMatchObject({ code: 'NOT_WHITELISTED' });
  });

  it('rejects unknown assets, zero amounts, and amounts over the per-withdrawal limit', async () => {
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    const send = (asset: string, amount: bigint) => env.withdrawals.request({ userId: 'alice', asset, amount, to, key: key() });
    await expect(send('DOGE', 1n)).rejects.toMatchObject({ code: 'UNKNOWN_ASSET' });
    await expect(send('ETH', 0n)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(send('ETH', ETH + 1n)).rejects.toMatchObject({ code: 'LIMIT_PER_TX' });
  });

  it('enforces the 24 hour limit, and failed withdrawals do not count', async () => {
    const a = await request('ETH', ETH);
    await request('ETH', ETH);
    await expect(request('ETH', 1n)).rejects.toMatchObject({ code: 'DAILY_LIMIT' });
    await pool.query(`UPDATE withdrawals SET status = 'failed' WHERE id = $1`, [a.withdrawal.id]);
    await expect(request('ETH', ETH)).resolves.toBeDefined();
    // Another user has their own allowance.
    await expect(request('ETH', ETH, 'bob')).resolves.toBeDefined();
  });

  it('cannot be pushed past the daily limit by parallel requests', async () => {
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => env.withdrawals.request({ userId: 'alice', asset: 'ETH', amount: parseEther('0.5'), to, key: key() })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4); // 4 x 0.5 = the 2 ETH limit
    const total = (await pool.query(`SELECT COALESCE(SUM(amount), 0)::text AS t FROM withdrawals`)).rows[0].t;
    expect(BigInt(total)).toBe(2n * ETH);
  });

  it('is idempotent on the key, and rejects a key reused with a different request', async () => {
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    const p = { userId: 'alice', asset: 'ETH', amount: parseEther('0.1'), to, key: 'same-key-1' };
    const a = await env.withdrawals.request(p);
    const b = await env.withdrawals.request(p);
    expect(b.replayed).toBe(true);
    expect(b.withdrawal.id).toBe(a.withdrawal.id);
    expect(env.queued).toHaveLength(1);
    await expect(env.withdrawals.request({ ...p, amount: parseEther('0.2') })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    expect((await pool.query('SELECT count(*)::int AS n FROM withdrawals')).rows[0].n).toBe(1);
  });

  it('stores the address in checksum form', async () => {
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    const r = await env.withdrawals.request({ userId: 'alice', asset: 'ETH', amount: 1n, to: to.toLowerCase(), key: key() });
    expect(r.withdrawal.to).toBe(getAddress(to));
  });
});

describe('sending', () => {
  it('sends ETH from the hot wallet and confirms after enough blocks', async () => {
    await env.fund(env.hot.address, 5n * ETH);
    const before = await env.chain.provider.getBalance(env.hot.address);
    const r = await request('ETH', parseEther('0.3'));

    await env.withdrawals.process(r.withdrawal.id);
    expect((await row(r.withdrawal.id)).status).toBe('broadcast');
    expect(await env.chain.provider.getBalance(r.to)).toBe(parseEther('0.3'));

    expect(await env.withdrawals.monitor()).toMatchObject({ confirmed: 0 }); // 1 of 2 confirmations
    await env.mine(1);
    expect(await env.withdrawals.monitor()).toMatchObject({ confirmed: 1 });
    const done = await env.withdrawals.get(r.withdrawal.id);
    expect(done).toMatchObject({ status: 'confirmed' });
    expect(done!.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const after = await env.chain.provider.getBalance(env.hot.address);
    expect(before - after).toBeGreaterThanOrEqual(parseEther('0.3')); // amount plus gas
    expect(before - after).toBeLessThan(parseEther('0.3') + parseEther('0.001'));

    expect(await env.withdrawals.deliver()).toBe(1);
    expect(env.sink.withdrawals[0]).toMatchObject({ id: r.withdrawal.id, status: 'confirmed' });
    expect(await env.withdrawals.deliver()).toBe(0);
  });

  it('sends ERC-20 tokens', async () => {
    await env.fund(env.hot.address, ETH);
    await env.mint(env.hot.address, 1_000_000_000n);
    const r = await request('tUSD', 25_000_000n);
    await env.withdrawals.process(r.withdrawal.id);
    expect(await env.tokenBalance(r.to)).toBe(25_000_000n);
    expect(await env.tokenBalance(env.hot.address)).toBe(975_000_000n);
    await env.mine(1);
    expect(await env.withdrawals.monitor()).toMatchObject({ confirmed: 1 });
  });

  it('pays out once even if the same withdrawal is processed many times, in parallel', async () => {
    await env.fund(env.hot.address, 5n * ETH);
    const r = await request('ETH', parseEther('0.3'));
    await Promise.all([1, 2, 3, 4].map(() => env.withdrawals.process(r.withdrawal.id)));
    await env.withdrawals.process(r.withdrawal.id);
    expect(await env.chain.provider.getBalance(r.to)).toBe(parseEther('0.3'));
    expect((await row(r.withdrawal.id)).tx_hashes).toHaveLength(1);
  });

  it('gives concurrent withdrawals distinct, consecutive nonces', async () => {
    await env.fund(env.hot.address, 10n * ETH);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => request('ETH', parseEther('0.1'), `user-${i}`)));
    await Promise.all(rs.map((r) => env.withdrawals.process(r.withdrawal.id)));
    const nonces = (await pool.query('SELECT nonce FROM withdrawals ORDER BY nonce')).rows.map((x) => Number(x.nonce));
    expect(new Set(nonces).size).toBe(6);
    expect(nonces[5] - nonces[0]).toBe(5);
    for (const r of rs) expect(await env.chain.provider.getBalance(r.to)).toBe(parseEther('0.1'));
  });

  it('survives a crash after signing: the saved transaction is re-sent, never re-signed', async () => {
    await env.fund(env.hot.address, 5n * ETH);
    await env.setAutomine(false);
    const r = await request('ETH', parseEther('0.3'));
    await env.withdrawals.process(r.withdrawal.id);
    const first = await row(r.withdrawal.id);
    expect(first.raw_tx).toBeTruthy();

    // Pretend the process died before it recorded that the broadcast succeeded.
    await pool.query(`UPDATE withdrawals SET status = 'broadcasting' WHERE id = $1`, [r.withdrawal.id]);
    const restarted = makeEnv(pool, token);
    await restarted.withdrawals.process(r.withdrawal.id);
    restarted.close();

    const second = await row(r.withdrawal.id);
    expect(second.raw_tx).toBe(first.raw_tx);
    expect(second.tx_hashes).toHaveLength(1);

    await env.setAutomine(true);
    await env.mine(3);
    await env.withdrawals.monitor();
    expect((await row(r.withdrawal.id)).status).toBe('confirmed');
    expect(await env.chain.provider.getBalance(r.to)).toBe(parseEther('0.3'));
  });

  it('recovers a withdrawal stuck in broadcasting by re-sending its saved transaction', async () => {
    await env.fund(env.hot.address, 5n * ETH);
    await env.setAutomine(false);
    const r = await request('ETH', parseEther('0.3'));
    await env.withdrawals.process(r.withdrawal.id);
    await pool.query(`UPDATE withdrawals SET status = 'broadcasting', updated_at = now() - interval '5 minutes' WHERE id = $1`, [r.withdrawal.id]);
    await env.setAutomine(true);
    await env.mine(3);
    await env.withdrawals.monitor();
    await env.withdrawals.monitor();
    expect((await row(r.withdrawal.id)).status).toBe('confirmed');
    expect(await env.chain.provider.getBalance(r.to)).toBe(parseEther('0.3'));
  });
});

describe('hot wallet problems', () => {
  it('asks for a retry when the hot wallet is empty, and fails after the last attempt', async () => {
    const r = await request('ETH', parseEther('0.3'));
    await expect(env.withdrawals.process(r.withdrawal.id, { attempt: 1, maxAttempts: 3 })).rejects.toBeInstanceOf(RetryableError);
    expect((await row(r.withdrawal.id)).status).toBe('queued');
    expect((await row(r.withdrawal.id)).raw_tx).toBeNull();

    await env.withdrawals.process(r.withdrawal.id, { attempt: 3, maxAttempts: 3 });
    expect(await env.withdrawals.get(r.withdrawal.id)).toMatchObject({ status: 'failed', error: 'Hot wallet balance too low' });
  });

  it('succeeds on a retry once the hot wallet is funded', async () => {
    const r = await request('ETH', parseEther('0.3'));
    await expect(env.withdrawals.process(r.withdrawal.id, { attempt: 1, maxAttempts: 3 })).rejects.toBeInstanceOf(RetryableError);
    await env.fund(env.hot.address, ETH);
    await env.withdrawals.process(r.withdrawal.id, { attempt: 2, maxAttempts: 3 });
    expect((await row(r.withdrawal.id)).status).toBe('broadcast');
  });

  it('fails a token withdrawal that would revert instead of sending it', async () => {
    await env.fund(env.hot.address, ETH); // gas, but no tokens
    const r = await request('tUSD', 1_000_000n);
    await env.withdrawals.process(r.withdrawal.id, { attempt: 1, maxAttempts: 3 });
    const w = await env.withdrawals.get(r.withdrawal.id);
    expect(w).toMatchObject({ status: 'failed' });
    expect(w!.error).toMatch(/would fail/);
    expect((await row(r.withdrawal.id)).raw_tx).toBeNull();
    expect(await env.tokenBalance(r.to)).toBe(0n);
  });

  it('does not fail a withdrawal that is already on the network', async () => {
    await env.fund(env.hot.address, 5n * ETH);
    const r = await request();
    await env.withdrawals.process(r.withdrawal.id);
    await env.withdrawals.markFailed(r.withdrawal.id, 'gave up');
    expect((await row(r.withdrawal.id)).status).toBe('broadcast');
  });
});

describe('stuck transactions', () => {
  it('replaces a stuck transaction with a higher fee at the same nonce, and pays out once', async () => {
    env.close();
    env = makeEnv(pool, token, { bumpAfterSec: 0 });
    await env.fund(env.hot.address, 5n * ETH);
    await env.setAutomine(false);
    const r = await request('ETH', parseEther('0.3'));
    await env.withdrawals.process(r.withdrawal.id);
    const original = await row(r.withdrawal.id);

    const result = await env.withdrawals.monitor();
    expect(result.bumped).toBe(1);
    const bumped = await row(r.withdrawal.id);
    expect(bumped.tx_hashes).toHaveLength(2);
    expect(bumped.gas_bumps).toBe(1);
    expect(bumped.nonce).toBe(original.nonce);
    const a = Transaction.from(original.raw_tx);
    const b = Transaction.from(bumped.raw_tx);
    expect(b.nonce).toBe(a.nonce);
    expect(b.maxFeePerGas!).toBeGreaterThanOrEqual((a.maxFeePerGas! * 110n) / 100n);
    expect(b.maxPriorityFeePerGas!).toBeGreaterThanOrEqual((a.maxPriorityFeePerGas! * 110n) / 100n);

    await env.setAutomine(true);
    await env.mine(3);
    await env.withdrawals.monitor();
    expect((await row(r.withdrawal.id)).status).toBe('confirmed');
    expect(await env.chain.provider.getBalance(r.to)).toBe(parseEther('0.3'));
    expect(await env.chain.provider.getTransactionReceipt(a.hash!)).toBeNull(); // the original never mined
    expect((await row(r.withdrawal.id)).tx_hash).toBe(b.hash);
  });

  it('stops bumping after the configured maximum', async () => {
    env.close();
    env = makeEnv(pool, token, { bumpAfterSec: 0, maxBumps: 2 });
    await env.fund(env.hot.address, 5n * ETH);
    await env.setAutomine(false);
    const r = await request();
    await env.withdrawals.process(r.withdrawal.id);
    for (let i = 0; i < 5; i++) await env.withdrawals.monitor();
    expect((await row(r.withdrawal.id)).gas_bumps).toBe(2);
  });

  it('flags a withdrawal whose nonce was used by some other transaction', async () => {
    await env.fund(env.hot.address, 5n * ETH);
    await env.setAutomine(false);
    const r = await request();
    await env.withdrawals.process(r.withdrawal.id);
    const w = await row(r.withdrawal.id);
    // Someone else spends the same nonce from the hot key: simulate by dropping our tx and mining a different one.
    await env.rpc('hardhat_dropTransaction', [w.tx_hash]);
    const other = await env.hot.wallet.sendTransaction({ to: randomAddress(), value: 1n, nonce: Number(w.nonce) });
    await env.setAutomine(true);
    await env.mine(1);
    await other.wait();
    await env.withdrawals.monitor();
    expect(await env.withdrawals.get(r.withdrawal.id)).toMatchObject({ status: 'failed' });
    expect((await row(r.withdrawal.id)).error).toMatch(/manual review/);
  });
});

describe('event delivery', () => {
  it('retries failed deliveries without duplicating', async () => {
    let down = true;
    const got: WithdrawalEvent[] = [];
    const flaky: EventSink = {
      async depositConfirmed() {},
      async withdrawalFinalized(e) {
        if (down) throw new Error('down');
        got.push(e);
      },
    };
    env.close();
    env = makeEnv(pool, token, {}, flaky);
    await env.fund(env.hot.address, 5n * ETH);
    const r = await request();
    await env.withdrawals.process(r.withdrawal.id);
    await env.mine(2);
    await env.withdrawals.monitor();
    expect(await env.withdrawals.deliver()).toBe(0);
    down = false;
    expect(await env.withdrawals.deliver()).toBe(1);
    expect(await env.withdrawals.deliver()).toBe(0);
    expect(got).toHaveLength(1);
  });
});
