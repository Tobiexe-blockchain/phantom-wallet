import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, HDNodeWallet, Wallet, parseEther } from 'ethers';
import solc from 'solc';
import type { Pool } from 'pg';
import { AddressService } from '../src/addresses.js';
import { Chain } from '../src/chain.js';
import type { AssetConfig, WalletConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { MemorySink, type EventSink } from '../src/events.js';
import { depositXpub } from '../src/hd.js';
import { HotWallet } from '../src/hot.js';
import { migrate } from '../src/migrate.js';
import { Secret } from '../src/secret.js';
import { Sweeper } from '../src/sweeper.js';
import { DepositWatcher } from '../src/watcher.js';
import { StaticWhitelist } from '../src/whitelist.js';
import { WithdrawalService } from '../src/withdrawals.js';

export const RPC_URL = process.env.TEST_RPC_URL ?? 'http://127.0.0.1:8545';
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/phantom_wallet';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const CHAIN_ID = 31337;
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
export const ETH_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
export const ETH = parseEther('1');

export async function setupDb(): Promise<Pool> {
  const pool = createPool(DATABASE_URL, 30);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(DATABASE_URL);
  return pool;
}

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE deposit_addresses, deposits, watcher_state, withdrawals, sweeps RESTART IDENTITY');
  await pool.query('ALTER SEQUENCE deposit_address_index_seq RESTART');
}

let compiled: { abi: any; bytecode: string } | undefined;
function compileToken() {
  if (compiled) return compiled;
  const input = { language: 'Solidity', sources: { 'TestToken.sol': { content: readFileSync(new URL('./fixtures/TestToken.sol', import.meta.url), 'utf8') } }, settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const c = out.contracts['TestToken.sol'].TestToken;
  compiled = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
  return compiled;
}

export async function deployToken(): Promise<string> {
  const chain = new Chain(RPC_URL, CHAIN_ID);
  try {
    const funder = new Wallet(HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC).privateKey, chain.provider);
    const { abi, bytecode } = compileToken();
    const token = await new ContractFactory(abi, bytecode, funder).deploy();
    await token.waitForDeployment();
    return await token.getAddress();
  } finally {
    chain.destroy();
  }
}

export const randomAddress = () => Wallet.createRandom().address;

export interface Env {
  cfg: WalletConfig;
  pool: Pool;
  chain: Chain;
  hot: HotWallet;
  mnemonic: string;
  addresses: AddressService;
  watcher: DepositWatcher;
  sweeper: Sweeper;
  withdrawals: WithdrawalService;
  sink: MemorySink;
  whitelist: StaticWhitelist;
  queued: string[];
  tokenAddress: string;
  funder: Wallet;
  token: Contract;
  rpc(method: string, params?: unknown[]): Promise<any>;
  mine(blocks?: number): Promise<void>;
  setAutomine(on: boolean): Promise<void>;
  fund(address: string, wei: bigint): Promise<void>;
  mint(address: string, amount: bigint): Promise<void>;
  tokenBalance(address: string): Promise<bigint>;
  close(): void;
}

export function makeEnv(pool: Pool, tokenAddress: string, overrides: Partial<WalletConfig> = {}, sink?: EventSink): Env {
  const mnemonic = Wallet.createRandom().mnemonic!.phrase;
  const assets: AssetConfig[] = [
    { symbol: 'ETH', type: 'native', decimals: 18, maxPerTx: ETH, dailyLimit: 2n * ETH, minSweep: parseEther('0.01'), hotMin: parseEther('0.1') },
    { symbol: 'tUSD', type: 'erc20', address: tokenAddress, decimals: 6, maxPerTx: 1_000_000_000n, dailyLimit: 2_000_000_000n, minSweep: 1_000n, hotMin: 1_000_000n },
  ];
  const cfg: WalletConfig = {
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    mnemonic: new Secret(mnemonic),
    apiKey: new Secret('test-api-key-test-api-key-1234'),
    assets,
    confirmations: 2,
    maxBlocksPerScan: 500,
    bumpAfterSec: 3600,
    bumpFactorPct: 125,
    maxBumps: 3,
    withdrawalAttempts: 3,
    retryBackoffMs: 50,
    watchIntervalMs: 1000,
    monitorIntervalMs: 1000,
    sweepIntervalMs: 0,
    port: 0,
    ...overrides,
  };
  const chain = new Chain(RPC_URL, CHAIN_ID);
  const funder = new Wallet(HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC).privateKey, chain.provider);
  const memory = new MemorySink();
  const useSink = sink ?? memory;
  const hot = new HotWallet(pool, chain, mnemonic);
  const queued: string[] = [];
  const whitelist = new StaticWhitelist();
  const token = new Contract(tokenAddress, ['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)'], funder);
  const rpc = (method: string, params: unknown[] = []) => chain.provider.send(method, params);

  const env: Env = {
    cfg,
    pool,
    chain,
    hot,
    mnemonic,
    addresses: new AddressService(pool, depositXpub(mnemonic)),
    watcher: new DepositWatcher(pool, chain, cfg, useSink),
    sweeper: new Sweeper(pool, chain, hot, { assets, mnemonic: cfg.mnemonic }),
    withdrawals: new WithdrawalService({ pool, chain, hot, config: cfg, whitelist, sink: useSink, enqueue: async (id) => void queued.push(id) }),
    sink: memory,
    whitelist,
    queued,
    tokenAddress,
    funder,
    token,
    rpc,
    async mine(blocks = 1) {
      await rpc('hardhat_mine', [`0x${blocks.toString(16)}`]);
    },
    async setAutomine(on) {
      await rpc('evm_setAutomine', [on]);
    },
    async fund(address, wei) {
      const tx = await funder.sendTransaction({ to: address, value: wei });
      await tx.wait();
    },
    async mint(address, amount) {
      const tx = await token.mint(address, amount);
      await tx.wait();
    },
    async tokenBalance(address) {
      return BigInt(await token.balanceOf(address));
    },
    close() {
      chain.destroy();
    },
  };
  return env;
}
