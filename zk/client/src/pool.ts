import type {Address, Hex, PublicClient, WalletClient} from "viem";
import {shieldedPoolAbi} from "./abi.js";
import type {Bundle, RagequitBundle} from "./wallet.js";

/** The (functionName, args) a bundle maps to on ShieldedPool. */
export function bundleCall(b: Bundle): {functionName: string; args: readonly unknown[]} {
  switch (b.kind) {
    case "transact":
      return {functionName: "transact", args: [b.proof, b.inputs, b.ext]};
    case "policyPay":
      return {functionName: "payWithPolicy", args: [b.proof, b.inputs, b.ext]};
    case "initBudget":
      return {functionName: "initBudget", args: [b.proof, b.budgetCommitment, b.timestamp, b.ext]};
    case "authorize":
      return {functionName: "authorizeTransfer", args: [b.proof, b.inputs, b.ext, b.auth]};
    case "swap":
      return {functionName: "swap", args: [b.proof, b.inputs, b.ext, b.swap]};
  }
}

/** Batch calls: transacts and policy payments can each be batched (one tree insertion). */
export function batchCall(bundles: Bundle[]): {functionName: string; args: readonly unknown[]} {
  if (bundles.every((b) => b.kind === "transact")) {
    return {functionName: "transactBatch", args: [bundles.map((b) => ({proof: b.proof, inputs: (b as Extract<Bundle, {kind: "transact"}>).inputs, ext: b.ext}))]};
  }
  if (bundles.every((b) => b.kind === "policyPay")) {
    return {functionName: "payWithPolicyBatch", args: [bundles.map((b) => ({proof: b.proof, inputs: (b as Extract<Bundle, {kind: "policyPay"}>).inputs, ext: b.ext}))]};
  }
  throw new Error("a batch must be all `transact` or all `policyPay` bundles");
}

/** eth_call the spend: checks roots, nullifiers, deadline AND the proof onchain, for free. */
export async function simulateBundle(client: PublicClient, pool: Address, b: Bundle, from?: Address): Promise<void> {
  const {functionName, args} = bundleCall(b);
  await client.simulateContract({address: pool, abi: shieldedPoolAbi, functionName: functionName as never, args: args as never, account: from});
}

export async function submitBundle(wallet: WalletClient, client: PublicClient, pool: Address, b: Bundle): Promise<{hash: Hex; gasUsed: bigint}> {
  const {functionName, args} = bundleCall(b);
  const hash = await wallet.writeContract({
    address: pool, abi: shieldedPoolAbi, functionName: functionName as never, args: args as never,
    account: wallet.account!, chain: wallet.chain,
  });
  const r = await client.waitForTransactionReceipt({hash});
  if (r.status !== "success") throw new Error(`pool.${functionName} reverted (${hash})`);
  return {hash, gasUsed: r.gasUsed};
}

export async function submitBatch(wallet: WalletClient, client: PublicClient, pool: Address, bundles: Bundle[]): Promise<{hash: Hex; gasUsed: bigint}> {
  const {functionName, args} = batchCall(bundles);
  const hash = await wallet.writeContract({
    address: pool, abi: shieldedPoolAbi, functionName: functionName as never, args: args as never,
    account: wallet.account!, chain: wallet.chain,
  });
  const r = await client.waitForTransactionReceipt({hash});
  if (r.status !== "success") throw new Error(`pool.${functionName} reverted (${hash})`);
  return {hash, gasUsed: r.gasUsed};
}

export async function submitRagequit(wallet: WalletClient, client: PublicClient, pool: Address, b: RagequitBundle): Promise<{hash: Hex; gasUsed: bigint}> {
  const hash = await wallet.writeContract({
    address: pool, abi: shieldedPoolAbi, functionName: "ragequit",
    args: [b.proof, b.root, b.nullifier, b.amount, b.token, b.label], account: wallet.account!, chain: wallet.chain,
  });
  const r = await client.waitForTransactionReceipt({hash});
  if (r.status !== "success") throw new Error(`pool.ragequit reverted (${hash})`);
  return {hash, gasUsed: r.gasUsed};
}
