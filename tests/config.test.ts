import { inspect } from 'node:util';
import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import { assertTestnet, loadConfig } from '../src/config.js';
import { Secret } from '../src/secret.js';

const base = () => ({
  RPC_URL: 'http://127.0.0.1:8545',
  CHAIN_ID: '31337',
  MNEMONIC: Wallet.createRandom().mnemonic!.phrase,
  API_KEY: 'a-long-api-key-for-the-tests-0000',
});

describe('config', () => {
  it('loads a testnet configuration with defaults', () => {
    const c = loadConfig(base());
    expect(c.chainId).toBe(31337);
    expect(c.assets[0]).toMatchObject({ symbol: 'ETH', type: 'native' });
    expect(typeof c.assets[0].maxPerTx).toBe('bigint');
  });

  it('refuses mainnet and other chains that are not on the testnet list', () => {
    for (const id of ['1', '10', '56', '137', '8453', '42161']) expect(() => loadConfig({ ...base(), CHAIN_ID: id })).toThrow(/testnet/i);
    expect(() => assertTestnet(11155111)).not.toThrow();
  });

  it('rejects an invalid mnemonic, a short API key, and an erc20 without an address', () => {
    expect(() => loadConfig({ ...base(), MNEMONIC: 'not a real phrase' })).toThrow();
    expect(() => loadConfig({ ...base(), API_KEY: 'short' })).toThrow();
    const bad = JSON.stringify([{ symbol: 'ETH', type: 'native', decimals: 18, maxPerTx: '1', dailyLimit: '1' }, { symbol: 'USDC', type: 'erc20', decimals: 6, maxPerTx: '1', dailyLimit: '1' }]);
    expect(() => loadConfig({ ...base(), ASSETS_JSON: bad })).toThrow(/address/);
  });

  it('never prints secrets', () => {
    const phrase = base().MNEMONIC;
    const c = loadConfig({ ...base(), MNEMONIC: phrase });
    const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    for (const out of [JSON.stringify(c, replacer), inspect(c, { depth: 5 }), String(c.mnemonic), `${c.apiKey}`]) {
      expect(out).not.toContain(phrase.split(' ')[0] + ' ' + phrase.split(' ')[1]);
      expect(out).not.toContain('a-long-api-key');
    }
    expect(new Secret('x').reveal()).toBe('x');
  });
});
