import { Interface, JsonRpcProvider, Network } from 'ethers';
import { assertTestnet, type AssetConfig } from './config.js';

export const ERC20 = new Interface([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const TRANSFER_TOPIC = ERC20.getEvent('Transfer')!.topicHash;

export class Chain {
  readonly provider: JsonRpcProvider;

  constructor(
    rpcUrl: string,
    readonly chainId: number,
  ) {
    assertTestnet(chainId);
    this.provider = new JsonRpcProvider(rpcUrl, chainId, {
      staticNetwork: Network.from(chainId),
      batchMaxCount: 1,
      // ethers caches some RPC answers for 250ms by default. Stale block heights and nonces are unsafe here.
      cacheTimeout: -1,
    });
  }

  /** Fails fast if the RPC endpoint is on a different chain than configured. */
  async verify(): Promise<void> {
    const reported = Number(BigInt(await this.provider.send('eth_chainId', [])));
    if (reported !== this.chainId) throw new Error(`RPC reports chain ${reported}, expected ${this.chainId}`);
  }

  async balanceOf(asset: AssetConfig, address: string): Promise<bigint> {
    if (asset.type === 'native') return this.provider.getBalance(address);
    const data = ERC20.encodeFunctionData('balanceOf', [address]);
    const out = await this.provider.call({ to: asset.address, data });
    return BigInt(ERC20.decodeFunctionResult('balanceOf', out)[0]);
  }

  /** EIP-1559 fees with a floor, so a node that reports zero tips does not stall transactions. */
  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const f = await this.provider.getFeeData();
    const priority = f.maxPriorityFeePerGas && f.maxPriorityFeePerGas > 0n ? f.maxPriorityFeePerGas : 1_000_000_000n;
    const maxFee = f.maxFeePerGas ?? f.gasPrice ?? 2_000_000_000n;
    return { maxFeePerGas: maxFee < priority ? priority : maxFee, maxPriorityFeePerGas: priority };
  }

  destroy(): void {
    this.provider.destroy();
  }
}

export const BENIGN_BROADCAST_ERROR = /already known|known transaction|nonce too low|NONCE_EXPIRED|already imported/i;

/** Broadcasts a signed transaction. Re-sending one that is already known to the node is not an error. */
export async function broadcast(chain: Chain, rawTx: string): Promise<void> {
  try {
    await chain.provider.broadcastTransaction(rawTx);
  } catch (err) {
    const text = `${(err as { code?: string }).code ?? ''} ${(err as Error).message ?? ''}`;
    if (!BENIGN_BROADCAST_ERROR.test(text)) throw err;
  }
}
