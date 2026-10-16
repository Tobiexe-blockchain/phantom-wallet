import { getAddress, Mnemonic } from 'ethers';
import { z } from 'zod';
import { Secret } from './secret.js';

/** Chains this service may talk to. Mainnets are refused on purpose. */
export const TESTNET_CHAIN_IDS = new Set([31337, 1337, 11155111, 17000, 560048, 80002, 84532, 421614, 11155420]);

export function assertTestnet(chainId: number): void {
  if (!TESTNET_CHAIN_IDS.has(chainId)) {
    throw new Error(`Chain ${chainId} is not on the testnet allowlist. This service is testnet only.`);
  }
}

export interface AssetConfig {
  symbol: string;
  type: 'native' | 'erc20';
  address?: string;
  decimals: number;
  /** Largest single withdrawal, in base units. */
  maxPerTx: bigint;
  /** Largest total per user per rolling 24 hours, in base units. */
  dailyLimit: bigint;
  /** Deposits below this are left in place instead of swept, in base units. */
  minSweep: bigint;
  /** The hot wallet is reported as low below this balance, in base units. */
  hotMin: bigint;
}

export interface WalletConfig {
  databaseUrl: string;
  redisUrl: string;
  rpcUrl: string;
  chainId: number;
  mnemonic: Secret;
  apiKey: Secret;
  assets: AssetConfig[];
  confirmations: number;
  maxBlocksPerScan: number;
  startBlock?: number;
  bumpAfterSec: number;
  bumpFactorPct: number;
  maxBumps: number;
  withdrawalAttempts: number;
  retryBackoffMs: number;
  watchIntervalMs: number;
  monitorIntervalMs: number;
  sweepIntervalMs: number;
  port: number;
  webhookUrl?: string;
  webhookSecret?: Secret;
}

const bigintString = z.string().regex(/^\d+$/).transform((v) => BigInt(v));

const assetSchema = z.object({
  symbol: z.string().min(2).max(10),
  type: z.enum(['native', 'erc20']),
  address: z.string().optional(),
  decimals: z.number().int().min(0).max(36),
  maxPerTx: bigintString,
  dailyLimit: bigintString,
  minSweep: bigintString.default(0n as never),
  hotMin: bigintString.default(0n as never),
});

const DEFAULT_ASSETS = JSON.stringify([
  { symbol: 'ETH', type: 'native', decimals: 18, maxPerTx: '1000000000000000000', dailyLimit: '5000000000000000000', minSweep: '10000000000000000', hotMin: '100000000000000000' },
]);

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/phantom_wallet'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  MNEMONIC: z.string().min(1),
  API_KEY: z.string().min(24, 'API_KEY must be at least 24 characters'),
  ASSETS_JSON: z.string().default(DEFAULT_ASSETS),
  CONFIRMATIONS: z.coerce.number().int().min(1).default(12),
  MAX_BLOCKS_PER_SCAN: z.coerce.number().int().positive().default(500),
  START_BLOCK: z.coerce.number().int().min(0).optional(),
  BUMP_AFTER_SEC: z.coerce.number().int().min(0).default(120),
  BUMP_FACTOR_PCT: z.coerce.number().int().min(110).default(125),
  MAX_BUMPS: z.coerce.number().int().min(0).default(5),
  WITHDRAWAL_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(15_000),
  WATCH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  PORT: z.coerce.number().int().default(3002),
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().min(16).optional(),
});

export function loadConfig(env: Record<string, string | undefined> = process.env): WalletConfig {
  const e = envSchema.parse(env);
  assertTestnet(e.CHAIN_ID);
  if (!Mnemonic.isValidMnemonic(e.MNEMONIC)) throw new Error('MNEMONIC is not a valid BIP-39 phrase');
  const assets = z.array(assetSchema).parse(JSON.parse(e.ASSETS_JSON)).map((a): AssetConfig => {
    if (a.type === 'erc20' && !a.address) throw new Error(`Asset ${a.symbol} needs an address`);
    return { ...a, address: a.address ? getAddress(a.address) : undefined };
  });
  if (!assets.some((a) => a.type === 'native')) throw new Error('ASSETS_JSON must include the native asset');
  if (e.WEBHOOK_URL && !e.WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET is required with WEBHOOK_URL');
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    rpcUrl: e.RPC_URL,
    chainId: e.CHAIN_ID,
    mnemonic: new Secret(e.MNEMONIC),
    apiKey: new Secret(e.API_KEY),
    assets,
    confirmations: e.CONFIRMATIONS,
    maxBlocksPerScan: e.MAX_BLOCKS_PER_SCAN,
    startBlock: e.START_BLOCK,
    bumpAfterSec: e.BUMP_AFTER_SEC,
    bumpFactorPct: e.BUMP_FACTOR_PCT,
    maxBumps: e.MAX_BUMPS,
    withdrawalAttempts: e.WITHDRAWAL_ATTEMPTS,
    retryBackoffMs: e.RETRY_BACKOFF_MS,
    watchIntervalMs: e.WATCH_INTERVAL_MS,
    monitorIntervalMs: e.MONITOR_INTERVAL_MS,
    sweepIntervalMs: e.SWEEP_INTERVAL_MS,
    port: e.PORT,
    webhookUrl: e.WEBHOOK_URL,
    webhookSecret: e.WEBHOOK_SECRET ? new Secret(e.WEBHOOK_SECRET) : undefined,
  };
}
