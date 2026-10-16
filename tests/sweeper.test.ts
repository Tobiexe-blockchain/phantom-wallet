import { parseEther } from 'ethers';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deployToken, ETH, makeEnv, resetDb, setupDb, type Env } from './helpers.js';

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
  await env.watcher.cycle();
});
afterEach(() => env.close());

/** Deposits, waits for confirmations, and lets the watcher confirm. */
async function confirmedDeposit(user: string, kind: 'ETH' | 'tUSD', amount: bigint) {
  const { address } = await env.addresses.getOrCreate(user);
  if (kind === 'ETH') await env.fund(address, amount);
  else await env.mint(address, amount);
  await env.mine(2);
  await env.watcher.cycle();
  return address;
}

describe('sweeping ETH', () => {
  it('moves a confirmed deposit to the hot wallet, leaving only dust', async () => {
    const address = await confirmedDeposit('alice', 'ETH', parseEther('1'));
    const hotBefore = await env.chain.provider.getBalance(env.hot.address);

    const result = await env.sweeper.sweepAll();
    expect(result.swept).toBe(1);

    const rec = (await pool.query(`SELECT amount::text AS amount, kind, asset FROM sweeps`)).rows;
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ kind: 'sweep', asset: 'ETH' });
    const hotAfter = await env.chain.provider.getBalance(env.hot.address);
    expect(hotAfter - hotBefore).toBe(BigInt(rec[0].amount));
    expect(await env.chain.provider.getBalance(address)).toBeLessThan(parseEther('0.001'));
    expect(BigInt(rec[0].amount)).toBeGreaterThan(parseEther('0.999'));
  });

  it('does nothing the second time', async () => {
    await confirmedDeposit('alice', 'ETH', parseEther('1'));
    await env.sweeper.sweepAll();
    const again = await env.sweeper.sweepAll();
    expect(again.swept).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM sweeps')).rows[0].n).toBe(1);
  });

  it('leaves an address alone while a deposit to it is still pending', async () => {
    const { address } = await env.addresses.getOrCreate('alice');
    await env.fund(address, parseEther('1'));
    await env.mine(2);
    await env.watcher.cycle(); // confirmed
    await env.fund(address, parseEther('0.5')); // second deposit, not yet confirmed
    await env.watcher.cycle();
    expect((await pool.query(`SELECT count(*)::int AS n FROM deposits WHERE status = 'pending'`)).rows[0].n).toBe(1);

    expect((await env.sweeper.sweepAll()).swept).toBe(0);
    expect(await env.chain.provider.getBalance(address)).toBe(parseEther('1.5'));
  });

  it('never sweeps an address that has no confirmed deposit', async () => {
    const { address } = await env.addresses.getOrCreate('alice');
    // Funds arrive in a way the watcher has not seen.
    await env.fund(address, parseEther('1'));
    expect((await env.sweeper.sweepAll()).swept).toBe(0);
    expect(await env.chain.provider.getBalance(address)).toBe(parseEther('1'));
  });

  it('skips amounts below the minimum', async () => {
    await confirmedDeposit('alice', 'ETH', parseEther('0.005'));
    expect((await env.sweeper.sweepAll()).swept).toBe(0);
  });

  it('sweeps several users in one run', async () => {
    await confirmedDeposit('alice', 'ETH', parseEther('1'));
    await confirmedDeposit('bob', 'ETH', parseEther('2'));
    expect((await env.sweeper.sweepAll()).swept).toBe(2);
  });
});

describe('sweeping tokens', () => {
  it('tops up gas from the hot wallet, then moves the tokens', async () => {
    await env.fund(env.hot.address, ETH);
    const address = await confirmedDeposit('alice', 'tUSD', 7_500_000n);
    expect(await env.chain.provider.getBalance(address)).toBe(0n);

    const result = await env.sweeper.sweepAll();
    expect(result).toMatchObject({ swept: 1, toppedUp: 1 });
    expect(await env.tokenBalance(address)).toBe(0n);
    expect(await env.tokenBalance(env.hot.address)).toBe(7_500_000n);

    const kinds = (await pool.query('SELECT kind FROM sweeps ORDER BY created_at')).rows.map((r) => r.kind);
    expect(kinds).toEqual(['gas_topup', 'sweep']);
  });

  it('does not top up again if the address already has enough gas', async () => {
    await env.fund(env.hot.address, ETH);
    const address = await confirmedDeposit('alice', 'tUSD', 1_000_000n);
    await env.fund(address, parseEther('0.05'));
    const result = await env.sweeper.sweepAll();
    expect(result.toppedUp).toBe(0);
    expect(await env.tokenBalance(env.hot.address)).toBe(1_000_000n);
    // The ETH left over after the token transfer is swept too.
    expect(await env.chain.provider.getBalance(address)).toBeLessThan(parseEther('0.01'));
  });
});

describe('hot wallet status', () => {
  it('reports balances and flags low ones', async () => {
    const before = await env.sweeper.hotStatus();
    expect(before.address).toBe(env.hot.address);
    expect(before.balances.find((b) => b.asset === 'ETH')).toMatchObject({ balance: '0', low: true });

    await env.fund(env.hot.address, ETH);
    await env.mint(env.hot.address, 5_000_000n);
    const after = await env.sweeper.hotStatus();
    expect(after.balances.find((b) => b.asset === 'ETH')).toMatchObject({ low: false });
    expect(after.balances.find((b) => b.asset === 'tUSD')).toMatchObject({ balance: '5000000', low: false });
  });
});
