/**
 * Local devnet helpers (anvil + forge). Used by the e2e tests, demos and benchmarks.
 * LOCAL ONLY: uses anvil's well-known, publicly documented test keys. Never point at a
 * real network.
 */
import {spawn, execFileSync, type ChildProcess} from "node:child_process";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createPublicClient, createWalletClient, http, keccak256, toHex, type Address, type Chain, type Hex,
  type PublicClient, type WalletClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {foundry} from "viem/chains";
import {attestationRegistryAbi, mockUsdcAbi, vendorRegistryAbi, vendorTreeAbi} from "./abi.js";

export const ZK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FOUNDRY_BIN = join(process.env.HOME ?? "", ".foundry", "bin");

/** anvil's default mnemonic accounts ("test test ... junk"): public, local-only. */
export const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

export interface Deployment {
  chainId: number;
  poseidon2: Address;
  transactVerifier: Address;
  policyPayVerifier: Address;
  budgetInitVerifier: Address;
  ragequitVerifier: Address;
  vendorRegistry: Address;
  attestationRegistry: Address;
  vendorTree: Address;
  associationSet: Address;
  pool: Address;
  usdc: Address;
  weth: Address;
  swapRouter: Address;
  swapAdapter: Address;
  deployBlock: number;
}

export interface Devnet {
  rpcUrl: string;
  chain: Chain;
  publicClient: PublicClient;
  wallet: (i: number) => WalletClient;
  address: (i: number) => Address;
  deployment: Deployment;
  stop: () => void;
}

export async function startAnvil(port = 8545, extraArgs: string[] = []): Promise<{rpcUrl: string; proc: ChildProcess}> {
  const proc = spawn(join(FOUNDRY_BIN, "anvil"), ["--port", String(port), "--silent", ...extraArgs], {stdio: "ignore"});
  const rpcUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(rpcUrl, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "eth_chainId", params: []})});
      if (r.ok) return {rpcUrl, proc};
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("anvil did not start");
}

/** Runs zk/contracts/script/Deploy.s.sol against a LOCAL anvil and returns the addresses. */
export function deployStack(rpcUrl: string): Deployment {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpcUrl)) throw new Error("deployStack is for local anvil only");
  const cwd = join(ZK_DIR, "contracts");
  execFileSync(join(FOUNDRY_BIN, "forge"), ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--private-key", ANVIL_KEYS[0]!], {cwd, stdio: "pipe"});
  return JSON.parse(readFileSync(join(cwd, "deployments", "anvil.json"), "utf8")) as Deployment;
}

export async function startDevnet(port = 8545): Promise<Devnet> {
  const {rpcUrl, proc} = await startAnvil(port);
  try {
    const deployment = deployStack(rpcUrl);
    const chain = {...foundry, rpcUrls: {default: {http: [rpcUrl]}}} as Chain;
    // 100 ms polling: viem defaults to 4 s, which dominated every receipt wait on anvil.
    const publicClient = createPublicClient({chain, transport: http(rpcUrl), pollingInterval: 100}) as PublicClient;
    const wallets = ANVIL_KEYS.map((k) => createWalletClient({account: privateKeyToAccount(k), chain, transport: http(rpcUrl)}));
    return {
      rpcUrl, chain, publicClient, deployment,
      wallet: (i) => wallets[i]!,
      address: (i) => wallets[i]!.account.address,
      stop: () => proc.kill(),
    };
  } catch (e) {
    proc.kill();
    throw e;
  }
}

async function send(d: Devnet, from: number, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<void> {
  const w = d.wallet(from);
  const hash = await w.writeContract({address, abi: abi as never, functionName: functionName as never, args: args as never, account: w.account!, chain: d.chain});
  const r = await d.publicClient.waitForTransactionReceipt({hash});
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}

/**
 * Registers a merchant in Grayr's VendorRegistry (owned by account `owner`), has the
 * deployer (VERIFIER_ROLE) attest it up to `level`, attests its categories, and publishes
 * its wallet into the VendorTree so policy proofs can find it.
 */
export async function registerVerifiedVendor(
  d: Devnet,
  p: {owner: number; domain: string; wallet: Address; level: 1 | 2 | 3 | 5; categories?: bigint},
): Promise<Hex> {
  const reg = d.deployment.vendorRegistry;
  await send(d, p.owner, reg, vendorRegistryAbi, "registerVendor", [p.domain, [], [p.wallet], `https://${p.domain}/x402`, `0x${"00".repeat(32)}`, ""]);
  const vendorId = (await d.publicClient.readContract({address: reg, abi: vendorRegistryAbi, functionName: "computeVendorId", args: [p.domain]})) as Hex;
  const block = await d.publicClient.getBlock();
  await send(d, 0, d.deployment.attestationRegistry, attestationRegistryAbi, "attest", [vendorId, p.level, keccak256(toHex(`evidence:${p.domain}`)), block.timestamp + 365n * 86400n]);
  if (p.categories) await send(d, 0, d.deployment.vendorTree, vendorTreeAbi, "setCategories", [vendorId, p.categories]);
  await send(d, 0, d.deployment.vendorTree, vendorTreeAbi, "publish", [vendorId, p.wallet]);
  return vendorId;
}

export async function mintUsdc(d: Devnet, to: Address, amount: bigint): Promise<void> {
  await send(d, 0, d.deployment.usdc, mockUsdcAbi, "mint", [to, amount]);
}

export async function erc20Balance(d: Devnet, token: Address, who: Address): Promise<bigint> {
  return (await d.publicClient.readContract({address: token, abi: mockUsdcAbi, functionName: "balanceOf", args: [who]})) as bigint;
}

export async function approve(d: Devnet, from: number, token: Address, spender: Address, amount: bigint): Promise<void> {
  await send(d, from, token, mockUsdcAbi, "approve", [spender, amount]);
}

export async function increaseTime(d: Devnet, seconds: number): Promise<void> {
  await d.publicClient.request({method: "evm_increaseTime" as never, params: [seconds] as never});
  await d.publicClient.request({method: "evm_mine" as never, params: [] as never});
}

/** Refresh a vendor's leaf in the VendorTree (permissionless: anyone can call publish). */
export async function publishVendor(d: Devnet, wallet: Address, from = 0): Promise<void> {
  const vendorId = (await d.publicClient.readContract({address: d.deployment.vendorRegistry, abi: vendorRegistryAbi, functionName: "vendorIdForWallet", args: [wallet]})) as Hex;
  await send(d, from, d.deployment.vendorTree, vendorTreeAbi, "publish", [vendorId, wallet]);
}
