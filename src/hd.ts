import { HDNodeWallet, Mnemonic } from 'ethers';
import type { HDNodeVoidWallet } from 'ethers';

/**
 * Key layout (BIP-44, coin type 60):
 *   deposit addresses  m/44'/60'/0'/0/{index}   one per user, derivable from the account xpub alone
 *   hot wallet         m/44'/60'/1'/0/0         a separate account, so no deposit key is the hot key
 *
 * Anything that only needs to hand out or recognize deposit addresses needs the xpub, not the mnemonic.
 */
const DEPOSIT_ACCOUNT = "m/44'/60'/0'";
const HOT_PATH = "m/44'/60'/1'/0/0";
const MAX_INDEX = 2 ** 31 - 1;

export function assertValidMnemonic(phrase: string): void {
  if (!Mnemonic.isValidMnemonic(phrase)) throw new Error('Invalid BIP-39 mnemonic');
}

/** Extended public key for the deposit account. Contains no private key material. */
export function depositXpub(mnemonic: string): string {
  assertValidMnemonic(mnemonic);
  return HDNodeWallet.fromPhrase(mnemonic, undefined, DEPOSIT_ACCOUNT).neuter().extendedKey;
}

export function deriveDepositAddress(xpub: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new Error('Invalid derivation index');
  const node = HDNodeWallet.fromExtendedKey(xpub) as HDNodeVoidWallet;
  return node.deriveChild(0).deriveChild(index).address;
}

/** Full key for one deposit address. Only the sweeper needs this. */
export function deriveDepositWallet(mnemonic: string, index: number): HDNodeWallet {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new Error('Invalid derivation index');
  return HDNodeWallet.fromPhrase(mnemonic, undefined, `${DEPOSIT_ACCOUNT}/0/${index}`);
}

export function deriveHotWallet(mnemonic: string): HDNodeWallet {
  assertValidMnemonic(mnemonic);
  return HDNodeWallet.fromPhrase(mnemonic, undefined, HOT_PATH);
}
