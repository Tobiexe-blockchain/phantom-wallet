# phantom-wallet

Testnet wallet service for a crypto exchange. It hands out a deposit address per user, watches the chain for incoming ETH and ERC-20 transfers, sends withdrawals from a hot wallet through a queue, replaces stuck transactions with higher fees, and sweeps deposits into the hot wallet.

> Testnet only, by design. The service refuses to start on any chain outside a short testnet list (local Hardhat, Sepolia, Holesky, Hoodi, Amoy, and the Base, Arbitrum and OP Sepolia networks). It has not been audited and must not hold real funds.

## What it does

| Area | Behavior |
|---|---|
| Deposit addresses | One address per user from a BIP-44 account (`m/44'/60'/0'/0/{index}`). Addresses come from the account's public key (xpub), so handing them out needs no private key. |
| Hot wallet | A separate account (`m/44'/60'/1'/0/0`), so no deposit key is the hot key. |
| Deposit watcher | Scans blocks for ETH sent to a deposit address and ERC-20 `Transfer` logs to one. A deposit is reported only after N confirmations. |
| Reorg safety | Re-scans the last N blocks every cycle and checks the block hash again before confirming. A deposit whose block vanished is marked orphaned and never reported. |
| Events | Confirmed deposits and finished withdrawals go to a webhook (HMAC signed) or a log. Delivery is at-least-once, so consumers deduplicate on the event `id`. |
| Withdrawals | Validated, limited, and checked against the whitelist, then queued in BullMQ and sent one at a time from the hot wallet. |
| Crash safety | The signed transaction is saved before it is broadcast. A retry re-sends the saved transaction and never signs a second one. |
| Stuck transactions | If a transaction is not mined in time, it is replaced at the same nonce with fees raised 25 percent, up to a maximum number of times. Only one of the two can be mined. |
| Sweeper | Moves confirmed deposits to the hot wallet. Pays gas for token transfers by topping up the deposit address from the hot wallet. |
| Hot wallet check | Reports balances and flags low ones. A withdrawal waits and retries while the hot wallet is short, then fails after the last attempt. |

## Run it

```bash
docker compose up -d                 # PostgreSQL and Redis
npm install
npx hardhat node                     # a local chain on :8545 (other terminal)
cp .env.example .env                 # fill in MNEMONIC and API_KEY
npm run dev
npm test                             # starts its own local chain if none is running
```

The test suite needs PostgreSQL and Redis running. Set `TEST_RPC_URL` to reuse a chain you already started.

## API

Internal service API. Callers send `x-api-key`. Do not expose it to browsers. Amounts are whole numbers in base units (wei), never decimals.

| Method | Path | Notes |
|---|---|---|
| POST | `/addresses` | `{ userId }` returns the user's deposit address, creating it once |
| GET | `/addresses/:userId` | |
| POST | `/withdrawals` | `{ userId, asset, amount, to }` with an `Idempotency-Key` header |
| GET | `/withdrawals/:id` | status: `queued`, `broadcasting`, `broadcast`, `confirmed`, `failed` |
| GET | `/deposits?userId=` | |
| GET | `/hot-wallet` | balances and low-balance flags |
| GET | `/health` | no key needed |

## Threat model

| Threat | What the service does | Tested in |
|---|---|---|
| Double credit of a deposit | One row per (tx hash, log index). Confirmation is a conditional update, so it happens once even with parallel cycles. | `watcher.test.ts` |
| Crediting a deposit that gets reorganized away | Block hash is re-checked before confirming. Orphaned deposits are never reported. | `watcher.test.ts` |
| Same withdrawal sent twice | Idempotency key at intake, a claim step when processing, and a saved signed transaction that is only re-sent. Also safe when the same job runs in parallel. | `withdrawals.test.ts`, `queue.test.ts` |
| Two withdrawals signed with the same nonce | The nonce is chosen under a database lock held until the transaction is saved and broadcast. | `withdrawals.test.ts` (fails if the lock is removed) |
| Exceeding the daily limit with parallel requests | Requests per user are serialized with an advisory lock around the limit check. | `withdrawals.test.ts` (fails if the lock is removed) |
| Crash between signing and broadcasting | The raw transaction is persisted first. A restart re-sends it. | `withdrawals.test.ts` |
| Stuck low-fee transaction | Replacement at the same nonce with at least a 10 percent bump. | `withdrawals.test.ts` |
| Withdrawal to the wrong place | Checksum validation, zero address, token contract, and the hot wallet are rejected. The address must be whitelisted. | `withdrawals.test.ts` |
| Paying out from an empty hot wallet | Checked before signing. Waits and retries, then fails cleanly. | `withdrawals.test.ts`, `queue.test.ts` |
| Sweeping funds that could still be reorganized away | An address is swept only when it has a confirmed deposit and no pending one. | `sweeper.test.ts` |
| Leaking the mnemonic | Held in a `Secret` object that prints as `[redacted]` in logs, JSON, and inspection. Never read except by the signing code. | `config.test.ts` |
| Running on mainnet by mistake | Chain ID is checked against a testnet allowlist at startup and the RPC's reported chain must match. | `config.test.ts` |
| Stale RPC answers | Client-side caching is turned off, so nonces and block heights are never old. (The test suite found this one.) | all chain tests |
| Unauthorized callers | Shared API key compared in constant time. | `api.test.ts` |

## Known limits

- **One process holds every key.** The same mnemonic derives the hot wallet and all deposit keys. In production, keep the xpub-only parts (addresses, watcher) apart from the signer, and keep keys in a KMS or HSM.
- **Only direct transfers are detected.** ETH sent by a contract (an internal transfer) does not appear as a top-level transaction, so it is missed.
- **Whitelist is a placeholder.** `server.ts` uses an in-memory list. Connect `WhitelistChecker` to the auth service's whitelist before relying on it.
- **Reorg protection is limited to the confirmation depth.** A deeper reorg is not handled.
- **No manual approval step** for large withdrawals, and no fee charged to users. The hot wallet pays gas.
- **Plain ERC-20 only.** Tokens that take a fee on transfer or rebase are not supported.
- **Dust.** Sweeping ETH leaves a tiny remainder from the gas estimate.
- **Redis loss.** Withdrawals are saved first, and `requeueStuck` re-queues any that never reached the queue.

## Connecting to the other services

- Credit the ledger from the `deposit.confirmed` event, using the event `id` as the idempotency key.
- Request withdrawals only after the ledger has locked the funds, and release or settle them on `withdrawal.confirmed` or `withdrawal.failed`.

## Structure

```
src/hd.ts          key derivation (xpub deposit addresses, hot wallet)
src/watcher.ts     deposit scanning, confirmation, delivery
src/withdrawals.ts intake, sending, monitoring, fee bumps
src/hot.ts         hot wallet and nonce lock
src/sweeper.ts     deposit sweeping and hot wallet status
src/queue.ts       BullMQ worker
src/app.ts         HTTP API
migrations/        SQL schema
tests/             69 tests against a local chain, PostgreSQL and Redis
```
