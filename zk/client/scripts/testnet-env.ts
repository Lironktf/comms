/**
 * Shared setup for the Base Sepolia scripts (testnet.ts, testnet-flows.ts). TESTNET ONLY:
 * refuses any chain but 84532. Key from TESTNET_PRIVATE_KEY, RPC from BASE_SEPOLIA_RPC_URL.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {createPublicClient, createWalletClient, fallback, http, type Address, type Hex, type PublicClient, type WalletClient} from "viem";
import {nonceManager, privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {AspService, blocklistRule} from "../src/asp.js";
import {PoolSync} from "../src/chain.js";
import {deriveAdminKeys, deriveAgentKeys, deriveSpendingKeys} from "../src/keys.js";
import {Prover} from "../src/prover.js";
import {AgentWallet, ShieldedWallet} from "../src/wallet.js";
import {VendorTreeSync} from "../src/vendors.js";
import {type PolicyParams} from "../src/hashes.js";
import {associationSetAbi, mockUsdcAbi} from "../src/abi.js";
import {ZK_DIR} from "../src/devnet.js";

// publicnode, then Tenderly's public gateway: the official sepolia.base.org caps eth_getLogs at
// 200 blocks and rate-limits the syncs (429). Both answered a 30k-block getLogs on 2026-10-17;
// publicnode also rate-limits (-32005), so the second one takes over when it does.
export const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com";
const RPCS = [RPC, ...(process.env.BASE_SEPOLIA_RPC_URL ? [] : ["https://base-sepolia.gateway.tenderly.co"])];
const transport = () => fallback(RPCS.map((u) => http(u, {retryCount: 4, retryDelay: 800})));
export const U = (x: number) => BigInt(Math.round(x * 1e6));
export const $ = (x: bigint) => `${(Number(x) / 1e6).toFixed(2)} USDC`;
export const tx = (h: Hex) => `https://sepolia.basescan.org/tx/${h}`;
export const step = (s: string) => console.log(`\n▶ ${s}`);
export const DOMAIN = "testnet-merchant.grayr.example";

const pk = process.env.TESTNET_PRIVATE_KEY as Hex | undefined;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("set TESTNET_PRIVATE_KEY (see the header of scripts/testnet.ts)");
// local nonce tracking: the public RPC is load-balanced and can report a stale pending nonce
export const account = privateKeyToAccount(pk, {nonceManager});
export const publicClient = createPublicClient({chain: baseSepolia, transport: transport(), pollingInterval: 1_000}) as PublicClient;
export const wallet: WalletClient = createWalletClient({account, chain: baseSepolia, transport: transport()});
if ((await publicClient.getChainId()) !== 84532) throw new Error("not Base Sepolia: refusing to run");
// Its nodes can also lag a block behind the one that returned a receipt, so a read right after
// a tx may not see it (seen 2026-10-17: attest right after registerVendor reverted with
// VendorNotFoundOrInactive). Every receipt wait here, the relayer's included, waits for catch-up.
const waitReceipt = publicClient.waitForTransactionReceipt.bind(publicClient);
publicClient.waitForTransactionReceipt = (async (args: Parameters<typeof waitReceipt>[0]) => {
  const r = await waitReceipt(args);
  for (let i = 0; i < 30 && (await publicClient.getBlockNumber({cacheTime: 0})) < r.blockNumber + 1n; i++) await new Promise((ok) => setTimeout(ok, 500));
  return r;
}) as typeof waitReceipt;

export const dep = JSON.parse(readFileSync(join(ZK_DIR, "contracts", "deployments", "84532.json"), "utf8")) as Record<string, string>;
export const pool = dep.pool as Address, usdc = dep.usdc as Address, fromBlock = BigInt(dep.deployBlock!);
export const me = account.address;
console.log(`account ${me}  pool ${pool}`);
console.log(`ETH ${Number(await publicClient.getBalance({address: me})) / 1e18}  USDC ${$(await erc20(usdc, me))}`);

export async function send(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await wallet.writeContract({address, abi: abi as never, functionName: functionName as never, args: args as never, account, chain: baseSepolia});
  const r = await publicClient.waitForTransactionReceipt({hash});
  if (r.status !== "success") throw new Error(`${functionName} reverted: ${tx(hash)}`);
  return hash;
}
export async function erc20(token: Address, who: Address): Promise<bigint> {
  return (await publicClient.readContract({address: token, abi: mockUsdcAbi, functionName: "balanceOf", args: [who]})) as bigint;
}
export const read = (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) =>
  publicClient.readContract({address, abi: abi as never, functionName: functionName as never, args: args as never}) as Promise<unknown>;

/**
 * Screen all deposits and publish the association-set root unless the chain already accepts it.
 * Always run this before spending: the wallet proves membership against this local set.
 */
export async function syncAssociationSet(asp: AspService): Promise<Hex | null> {
  await asp.refresh();
  if (await read(dep.associationSet as Address, associationSetAbi, "isValidRoot", [asp.current.root])) return null;
  return asp.publish(wallet, publicClient);
}

/** The two shielded wallets (seed in ~/.config/grayr-zk/testnet-seed) and their services. */
export async function openWallets() {
  const seedDir = join(homedir(), ".config", "grayr-zk");
  const seedFile = join(seedDir, "testnet-seed");
  if (!existsSync(seedFile)) {
    mkdirSync(seedDir, {recursive: true, mode: 0o700});
    writeFileSync(seedFile, randomBytes(32).toString("hex"), {mode: 0o600});
    console.log(`  new wallet seed in ${seedFile} (testnet only; back it up if you care)`);
  }
  const seed = Uint8Array.from(Buffer.from(readFileSync(seedFile, "utf8").trim(), "hex"));
  const prover = new Prover();
  const vendors = new VendorTreeSync(publicClient, dep.vendorTree as Address, fromBlock);
  await vendors.sync();
  const asp = new AspService(new PoolSync(publicClient, pool, fromBlock), dep.associationSet as Address, blocklistRule([]));
  const admin = deriveAdminKeys(seed);
  const policy: PolicyParams = {
    adminPk: admin.adminPk, token: BigInt(usdc), maxPerPayment: U(1), maxFee: U(0.05), periodBudget: U(5), periodSeconds: 86400n,
    minVendorLevel: 2n, categoryMask: 0b010n, requireVerifiedVendor: true,
  };
  const base = {chainId: 84532n, pool, prover, asp};
  const human = new ShieldedWallet({...base, keys: deriveSpendingKeys(seed), sync: new PoolSync(publicClient, pool, fromBlock)});
  const agent = new AgentWallet({...base, keys: deriveAgentKeys(seed, 0), sync: new PoolSync(publicClient, pool, fromBlock), policy, vendors});
  await human.refresh();
  await agent.refresh();
  return {prover, asp, admin, policy, human, agent, vendors};
}
