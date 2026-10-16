import { parseEther } from 'ethers';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DepositEvent, EventSink } from '../src/events.js';
import { deployToken, ETH, makeEnv, randomAddress, resetDb, setupDb, type Env } from './helpers.js';

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
  await env.watcher.cycle(); // sets the starting block
});
afterEach(async () => {
  await env.setAutomine(true);
  env.close();
});

const count = async (status: string) => (await pool.query('SELECT count(*)::int AS n FROM deposits WHERE status = $1', [status])).rows[0].n as number;

describe('native deposits', () => {
  it('waits for confirmations, then confirms and reports exactly once', async () => {
    const { address } = await env.addresses.getOrCreate('alice');
    await env.fund(address, parseEther('0.5'));

    const first = await env.watcher.cycle();
    expect(first.found).toBe(1);
    expect(await count('pending')).toBe(1);
    expect(env.sink.deposits).toHaveLength(0);

    await env.mine(1);
    const second = await env.watcher.cycle();
    expect(second.confirmed).toBe(1);
    expect(env.sink.deposits).toHaveLength(1);
    expect(env.sink.deposits[0]).toMatchObject({ userId: 'alice', asset: 'ETH', amount: parseEther('0.5').toString(), address });

    await env.mine(3);
    await env.watcher.cycle();
    await env.watcher.cycle();
    expect(env.sink.deposits).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM deposits')).rows[0].n).toBe(1);
  });

  it('records several deposits to the same address separately', async () => {
    const { address } = await env.addresses.getOrCreate('alice');
    await env.fund(address, parseEther('0.1'));
    await env.fund(address, parseEther('0.2'));
    await env.mine(2);
    await env.watcher.cycle();
    expect(env.sink.deposits.map((d) => d.amount).sort()).toEqual([parseEther('0.1').toString(), parseEther('0.2').toString()].sort());
  });

  it('ignores other addresses and zero-value transfers', async () => {
    const { address } = await env.addresses.getOrCreate('alice');
    await env.fund(randomAddress(), ETH);
    await env.fund(address, 0n);
    await env.mine(3);
    const r = await env.watcher.cycle();
    expect(r.found).toBe(0);
    expect(env.sink.deposits).toHaveLength(0);
  });

  it('matches deposits to the right user', async () => {
    const a = await env.addresses.getOrCreate('alice');
    const b = await env.addresses.getOrCreate('bob');
    await env.fund(a.address, parseEther('0.1'));
    await env.fund(b.address, parseEther('0.3'));
    await env.mine(2);
    await env.watcher.cycle();
    const byUser = Object.fromEntries(env.sink.deposits.map((d) => [d.userId, d.amount]));
    expect(byUser).toEqual({ alice: parseEther('0.1').toString(), bob: parseEther('0.3').toString() });
  });

  it('lets only one of two simultaneous cycles run, and still confirms once', async () => {
    const { address } = await env.addresses.getOrCreate('alice');
    await env.fund(address, parseEther('0.5'));
    await env.mine(2);
    await Promise.all([env.watcher.cycle(), env.watcher.cycle(), env.watcher.cycle()]);
    await env.watcher.cycle();
    expect(env.sink.deposits).toHaveLength(1);
  });
});

describe('token deposits', () => {
  it('detects ERC-20 transfers to a deposit address', async () => {
    const { address } = await env.addresses.getOrCreate('alice');
    await env.mint(address, 5_000_000n);
    await env.mine(2);
    await env.watcher.cycle();
    expect(env.sink.deposits).toHaveLength(1);
    expect(env.sink.deposits[0]).toMatchObject({ asset: 'tUSD', amount: '5000000', userId: 'alice' });
  });

  it('ignores token transfers to other addresses', async () => {
    await env.addresses.getOrCreate('alice');
    await env.mint(randomAddress(), 5_000_000n);
    await env.mine(2);
    expect((await env.watcher.cycle()).found).toBe(0);
  });
});

describe('chain reorganizations', () => {
  it('never confirms a deposit whose block was removed from the chain', async () => {
    const { address } = await env.addresses.getOrCreate('alice');
    const snapshot = await env.rpc('evm_snapshot');
    await env.fund(address, parseEther('0.5'));
    await env.watcher.cycle();
    expect(await count('pending')).toBe(1);

    await env.rpc('evm_revert', [snapshot]); // the deposit block disappears
    await env.mine(4);
    const r = await env.watcher.cycle();
    expect(r.orphaned).toBe(1);
    expect(await count('orphaned')).toBe(1);
    expect(env.sink.deposits).toHaveLength(0);
  });

  it('corrects a stored block hash that no longer matches the chain', async () => {
    const { address } = await env.addresses.getOrCreate('alice');
    await env.fund(address, parseEther('0.5'));
    await env.watcher.cycle();
    const before = await pool.query('SELECT block_hash FROM deposits');

    // Simulate a re-org by rewriting the stored block hash, as if the first inclusion had been replaced.
    await pool.query(`UPDATE deposits SET block_hash = '0x${'ab'.repeat(32)}'`);
    await env.mine(3);
    await env.watcher.cycle();
    const after = await pool.query('SELECT block_hash, status FROM deposits');
    expect(after.rows[0].block_hash).toBe(before.rows[0].block_hash); // corrected back to the real block
    expect(after.rows[0].status).toBe('confirmed');
    expect(env.sink.deposits).toHaveLength(1);
  });
});

describe('event delivery', () => {
  it('retries a failed delivery until the sink accepts it, without duplicates', async () => {
    let fail = true;
    const received: DepositEvent[] = [];
    const flaky: EventSink = {
      async depositConfirmed(e) {
        if (fail) throw new Error('down');
        received.push(e);
      },
      async withdrawalFinalized() {},
    };
    env.close();
    env = makeEnv(pool, token, {}, flaky);
    await env.watcher.cycle();

    const { address } = await env.addresses.getOrCreate('alice');
    await env.fund(address, parseEther('0.5'));
    await env.mine(2);
    await env.watcher.cycle();
    expect(received).toHaveLength(0);
    expect((await pool.query('SELECT status, notified_at FROM deposits')).rows[0]).toMatchObject({ status: 'confirmed', notified_at: null });

    fail = false;
    await env.watcher.cycle();
    await env.watcher.cycle();
    expect(received).toHaveLength(1);
  });
});

