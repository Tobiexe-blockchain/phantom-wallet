import { AddressService } from './addresses.js';
import { buildApp } from './app.js';
import { Chain } from './chain.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { LogSink, WebhookSink, type EventSink } from './events.js';
import { depositXpub } from './hd.js';
import { HotWallet } from './hot.js';
import { migrate } from './migrate.js';
import { createWithdrawalQueue, type WithdrawalQueue } from './queue.js';
import { Sweeper } from './sweeper.js';
import { DepositWatcher } from './watcher.js';
import { HttpWhitelistChecker, StaticWhitelist, type WhitelistChecker } from './whitelist.js';
import { WithdrawalService } from './withdrawals.js';

const config = loadConfig();
await migrate(config.databaseUrl);

const pool = createPool(config.databaseUrl);
const chain = new Chain(config.rpcUrl, config.chainId);
await chain.verify();

const mnemonic = config.mnemonic.reveal();
const hot = new HotWallet(pool, chain, mnemonic);
const sink: EventSink = config.webhookUrl && config.webhookSecret ? new WebhookSink(config.webhookUrl, config.webhookSecret) : new LogSink();
const addresses = new AddressService(pool, depositXpub(mnemonic));
const watcher = new DepositWatcher(pool, chain, config, sink);
const sweeper = new Sweeper(pool, chain, hot, { assets: config.assets, mnemonic: config.mnemonic });

let whitelist: WhitelistChecker;
if (config.whitelistUrl && config.whitelistServiceKey) {
  whitelist = new HttpWhitelistChecker(config.whitelistUrl, config.whitelistServiceKey);
} else {
  console.warn('WHITELIST_URL is not set: every withdrawal will be refused because no address is whitelisted.');
  whitelist = new StaticWhitelist();
}

let queue: WithdrawalQueue | undefined;
const withdrawals: WithdrawalService = new WithdrawalService({
  pool,
  chain,
  hot,
  config,
  whitelist,
  sink,
  enqueue: (id) => queue!.enqueue(id),
});
queue = createWithdrawalQueue(config, withdrawals);

const app = buildApp({ apiKey: config.apiKey, addresses, withdrawals, sweeper, pool });

const loop = (name: string, everyMs: number, fn: () => Promise<unknown>) => {
  if (everyMs <= 0) return undefined;
  const timer = setInterval(() => fn().catch((e) => console.error(`${name} failed: ${(e as Error).message}`)), everyMs);
  return timer;
};
watcher.start(config.watchIntervalMs);
const timers = [
  loop('monitor', config.monitorIntervalMs, async () => {
    await withdrawals.monitor();
    await withdrawals.deliver();
    await withdrawals.requeueStuck();
  }),
  loop('sweep', config.sweepIntervalMs, () => sweeper.sweepAll()),
];

const shutdown = async () => {
  watcher.stop();
  timers.forEach((t) => t && clearInterval(t));
  await app.close();
  await queue?.close();
  chain.destroy();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`phantom-wallet listening on :${config.port} (chain ${config.chainId}, hot wallet ${hot.address})`);
