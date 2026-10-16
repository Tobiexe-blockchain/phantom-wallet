import { HDNodeVoidWallet, HDNodeWallet, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import { deriveDepositAddress, deriveDepositWallet, deriveHotWallet, depositXpub } from '../src/hd.js';

const mnemonic = Wallet.createRandom().mnemonic!.phrase;

describe('HD wallet', () => {
  it('derives the same deposit address from the xpub as from the mnemonic', () => {
    const xpub = depositXpub(mnemonic);
    for (const i of [0, 1, 2, 57, 1000]) {
      expect(deriveDepositAddress(xpub, i)).toBe(deriveDepositWallet(mnemonic, i).address);
    }
  });

  it('gives every index a different address', () => {
    const xpub = depositXpub(mnemonic);
    const set = new Set(Array.from({ length: 200 }, (_, i) => deriveDepositAddress(xpub, i)));
    expect(set.size).toBe(200);
  });

  it('keeps the xpub free of private key material', () => {
    const xpub = depositXpub(mnemonic);
    expect(xpub.startsWith('xpub')).toBe(true);
    const node = HDNodeWallet.fromExtendedKey(xpub);
    expect(node instanceof HDNodeVoidWallet).toBe(true);
    expect((node as unknown as { privateKey?: string }).privateKey).toBeUndefined();
  });

  it('uses a hot wallet key that no deposit address shares', () => {
    const hot = deriveHotWallet(mnemonic).address;
    const xpub = depositXpub(mnemonic);
    for (let i = 0; i < 100; i++) expect(deriveDepositAddress(xpub, i)).not.toBe(hot);
  });

  it('is deterministic and different for different mnemonics', () => {
    const other = Wallet.createRandom().mnemonic!.phrase;
    expect(depositXpub(mnemonic)).toBe(depositXpub(mnemonic));
    expect(depositXpub(other)).not.toBe(depositXpub(mnemonic));
  });

  it('rejects bad input', () => {
    expect(() => depositXpub('not a real phrase')).toThrow();
    expect(() => deriveHotWallet('nope')).toThrow();
    const xpub = depositXpub(mnemonic);
    for (const bad of [-1, 1.5, 2 ** 31]) expect(() => deriveDepositAddress(xpub, bad)).toThrow();
  });
});
