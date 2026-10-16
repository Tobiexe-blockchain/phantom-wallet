import { parseEther } from 'ethers';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { deployToken, ETH, makeEnv, randomAddress, resetDb, setupDb, type Env } from './helpers.js';

let pool: Pool;
let token: string;
let env: Env;
let app: FastifyInstance;
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
  app = buildApp({ apiKey: env.cfg.apiKey, addresses: env.addresses, withdrawals: env.withdrawals, sweeper: env.sweeper, pool });
});
afterEach(async () => {
  await app.close();
  env.close();
});

const KEY = 'test-api-key-test-api-key-1234';
const call = async (method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = { 'x-api-key': KEY }) => {
  const res = await app.inject({ method, url, payload: body as object | undefined, headers });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

describe('authentication', () => {
  it('rejects requests without the right key, but leaves /health open', async () => {
    expect((await call('GET', '/hot-wallet', undefined, {})).status).toBe(401);
    expect((await call('GET', '/hot-wallet', undefined, { 'x-api-key': 'wrong-key-wrong-key-wrong-key' })).status).toBe(401);
    expect((await call('POST', '/addresses', { userId: 'a' }, {})).status).toBe(401);
    expect((await call('GET', '/health', undefined, {})).status).toBe(200);
  });
});

describe('addresses', () => {
  it('returns the same address for the same user', async () => {
    const a = await call('POST', '/addresses', { userId: 'alice' });
    const b = await call('POST', '/addresses', { userId: 'alice' });
    expect(a.status).toBe(200);
    expect(a.body.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(b.body).toEqual(a.body);
    expect((await call('GET', '/addresses/alice')).body).toEqual(a.body);
    expect((await call('GET', '/addresses/nobody')).status).toBe(404);
  });

  it('rejects bad input', async () => {
    expect((await call('POST', '/addresses', {})).status).toBe(400);
    expect((await call('POST', '/addresses', { userId: 'a', extra: 1 })).status).toBe(400);
  });
});

describe('withdrawals', () => {
  it('creates a withdrawal, replays it on the same key, and reads it back', async () => {
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    const body = { userId: 'alice', asset: 'ETH', amount: parseEther('0.1').toString(), to };
    const headers = { 'x-api-key': KEY, 'idempotency-key': 'api-1' };
    const first = await call('POST', '/withdrawals', body, headers);
    expect(first.status).toBe(201);
    expect(first.body.withdrawal.status).toBe('queued');
    const second = await call('POST', '/withdrawals', body, headers);
    expect(second.status).toBe(200);
    expect(second.body.withdrawal.id).toBe(first.body.withdrawal.id);
    expect((await call('GET', `/withdrawals/${first.body.withdrawal.id}`)).body.status).toBe('queued');
  });

  it('needs an idempotency key and rejects amounts that are not whole base units', async () => {
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    expect((await call('POST', '/withdrawals', { userId: 'alice', asset: 'ETH', amount: '100', to })).body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    for (const amount of ['1.5', '0', '-1', '1e18', 'abc', '']) {
      const res = await call('POST', '/withdrawals', { userId: 'alice', asset: 'ETH', amount, to }, { 'x-api-key': KEY, 'idempotency-key': `bad-${amount}` });
      expect(res.status, amount).toBe(400);
    }
  });

  it('returns clear errors for business rules', async () => {
    const headers = { 'x-api-key': KEY, 'idempotency-key': 'api-2' };
    const res = await call('POST', '/withdrawals', { userId: 'alice', asset: 'ETH', amount: '100', to: randomAddress() }, headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_WHITELISTED');
  });
});

describe('listing withdrawals', () => {
  it('returns only the asked-for user\'s withdrawals', async () => {
    const to = randomAddress();
    env.whitelist.allow('alice', to);
    env.whitelist.allow('bob', to);
    for (const [user, key] of [['alice', 'l-1'], ['alice', 'l-2'], ['bob', 'l-3']]) {
      await call('POST', '/withdrawals', { userId: user, asset: 'ETH', amount: '100', to }, { 'x-api-key': KEY, 'idempotency-key': key });
    }
    const res = await call('GET', '/withdrawals?userId=alice');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((w: any) => w.userId === 'alice')).toBe(true);
    expect((await call('GET', '/withdrawals')).status).toBe(400);
  });
});

describe('deposits and hot wallet', () => {
  it('lists a user\'s deposits', async () => {
    await env.watcher.cycle();
    const { address } = await env.addresses.getOrCreate('alice');
    await env.fund(address, parseEther('0.4'));
    await env.mine(2);
    await env.watcher.cycle();
    const res = await call('GET', '/deposits?userId=alice');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ asset: 'ETH', amount: parseEther('0.4').toString(), status: 'confirmed' });
    expect((await call('GET', '/deposits')).status).toBe(400);
  });

  it('shows the hot wallet', async () => {
    await env.fund(env.hot.address, ETH);
    const res = await call('GET', '/hot-wallet');
    expect(res.body.address).toBe(env.hot.address);
    expect(res.body.balances[0]).toMatchObject({ asset: 'ETH', balance: ETH.toString() });
  });
});
