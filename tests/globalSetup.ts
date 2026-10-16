import { spawn, type ChildProcess } from 'node:child_process';

const RPC = process.env.TEST_RPC_URL ?? 'http://127.0.0.1:8545';
let child: ChildProcess | undefined;

async function alive(): Promise<boolean> {
  try {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Uses a chain that is already running at TEST_RPC_URL, or starts a local Hardhat node. */
export async function setup(): Promise<void> {
  if (await alive()) return;
  const port = new URL(RPC).port || '8545';
  child = spawn('npx', ['hardhat', 'node', '--port', port], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) {
    if (await alive()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Local chain did not start at ${RPC}`);
}

export async function teardown(): Promise<void> {
  if (child?.pid) {
    try {
      process.kill(-child.pid);
    } catch {
      child.kill();
    }
  }
}
