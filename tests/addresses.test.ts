import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveDepositAddress, depositXpub } from '../src/hd.js';
import { deployToken, makeEnv, resetDb, setupDb, type Env } from './helpers.js';

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

describe('deposit addresses', () => {
  it('gives each user one stable address that matches the derivation', async () => {
    const a = await env.addresses.getOrCreate('alice');
    const again = await env.addresses.getOrCreate('alice');
    expect(again).toEqual(a);
    expect(a.address).toBe(deriveDepositAddress(depositXpub(env.mnemonic), a.derivationIndex));
  });

  it('gives different users different addresses and indexes', async () => {
    const a = await env.addresses.getOrCreate('alice');
    const b = await env.addresses.getOrCreate('bob');
    expect(a.address).not.toBe(b.address);
    expect(a.derivationIndex).not.toBe(b.derivationIndex);
  });

  it('creates exactly one address when the same user asks many times at once', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => env.addresses.getOrCreate('alice')));
    expect(new Set(results.map((r) => r.address)).size).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM deposit_addresses')).rows[0].n).toBe(1);
  });

  it('hands out many unique addresses under parallel load', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => env.addresses.getOrCreate(`user-${i}`)));
    expect(new Set(results.map((r) => r.address)).size).toBe(30);
    expect(new Set(results.map((r) => r.derivationIndex)).size).toBe(30);
  });

  it('returns null for a user who has no address yet', async () => {
    expect(await env.addresses.get('nobody')).toBeNull();
  });
});
