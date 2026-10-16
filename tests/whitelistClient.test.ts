import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Secret } from '../src/secret.js';
import { HttpWhitelistChecker } from '../src/whitelist.js';

const KEY = 'service-key-service-key-123456';
let server: Server;
let base: string;
let seen: IncomingMessage[] = [];
let reply: { status: number; body: string; delayMs?: number } = { status: 200, body: '{"allowed":true}' };

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    setTimeout(() => {
      res.statusCode = reply.status;
      res.setHeader('content-type', 'application/json');
      res.end(reply.body);
    }, reply.delayMs ?? 0);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  seen = [];
  reply = { status: 200, body: '{"allowed":true}' };
});

const checker = (url = base, timeout = 2000) => new HttpWhitelistChecker(url, new Secret(KEY), timeout);
const ADDR = '0x52908400098527886E0F7030069857D2E4169EE7';

describe('HttpWhitelistChecker', () => {
  it('sends the service key and the question, and returns the answer', async () => {
    expect(await checker().isAllowed('user-1', 'ethereum', ADDR)).toBe(true);
    expect(seen[0].headers['x-service-key']).toBe(KEY);
    expect(seen[0].url).toBe(`/internal/whitelist/allowed?userId=user-1&network=ethereum&address=${ADDR}`);
    reply = { status: 200, body: '{"allowed":false}' };
    expect(await checker().isAllowed('user-1', 'ethereum', ADDR)).toBe(false);
  });

  it('treats anything other than a real true as no', async () => {
    for (const body of ['{"allowed":"true"}', '{"allowed":1}', '{}', 'null', 'not json']) {
      reply = { status: 200, body };
      expect(await checker().isAllowed('u', 'ethereum', ADDR), body).toBe(false);
    }
  });

  it('refuses instead of guessing when the whitelist service errors, rejects the key, or is unreachable', async () => {
    for (const status of [401, 404, 429, 500, 503]) {
      reply = { status, body: '{"allowed":true}' };
      await expect(checker().isAllowed('u', 'ethereum', ADDR), String(status)).rejects.toMatchObject({ code: 'WHITELIST_UNAVAILABLE', status: 503 });
    }
    await expect(checker('http://127.0.0.1:1').isAllowed('u', 'ethereum', ADDR)).rejects.toMatchObject({ code: 'WHITELIST_UNAVAILABLE' });
  });

  it('gives up on a slow service', async () => {
    reply = { status: 200, body: '{"allowed":true}', delayMs: 800 };
    await expect(checker(base, 100).isAllowed('u', 'ethereum', ADDR)).rejects.toMatchObject({ code: 'WHITELIST_UNAVAILABLE' });
  });

  it('is configured through the environment, and both settings are required together', () => {
    const env = { RPC_URL: 'http://127.0.0.1:8545', CHAIN_ID: '31337', MNEMONIC: 'test test test test test test test test test test test junk', API_KEY: 'a-long-api-key-for-the-tests-0000' };
    expect(loadConfig({ ...env, WHITELIST_URL: base, WHITELIST_SERVICE_KEY: KEY }).whitelistUrl).toBe(base);
    expect(() => loadConfig({ ...env, WHITELIST_URL: base })).toThrow(/together/);
    expect(() => loadConfig({ ...env, WHITELIST_SERVICE_KEY: KEY })).toThrow(/together/);
  });
});
