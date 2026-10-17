import type {Address, Hex, PublicClient, WalletClient} from "viem";
import {paymentBookAbi, shieldedPoolAbi} from "./abi.js";
import type {PaymentRecordView} from "./chain.js";
import type {Bundle, EscrowAction, RagequitBundle} from "./wallet.js";

/** The (functionName, args) a bundle maps to on ShieldedPool. */
export function bundleCall(b: Bundle): {functionName: string; args: readonly unknown[]} {
  switch (b.kind) {
    case "transact":
      return {functionName: "transact", args: [b.proof, b.inputs, b.ext]};
    case "pay":
      return {functionName: "pay", args: [b.proof, b.inputs, b.ext, b.opts]};
    case "policyPay":
      return {functionName: "payWithPolicy", args: [b.proof, b.inputs, b.ext, b.opts]};
    case "initBudget":
      return {functionName: "initBudget", args: [b.proof, b.budgetCommitment, b.timestamp, b.ext]};
    case "authorize":
      return {functionName: "authorizeTransfer", args: [b.proof, b.inputs, b.ext, b.auth]};
    case "swap":
      return {functionName: "swap", args: [b.proof, b.inputs, b.ext, b.swap]};
  }
}

/** Bundle kinds pool.batch accepts: any mix of these goes in ONE transaction. */
export const BATCHABLE = new Set<Bundle["kind"]>(["transact", "pay", "policyPay"]);

/** pool.batch(transacts, pays, policyPays): one tx, one tree insertion for the whole mix. */
export function batchCall(bundles: Bundle[]): {functionName: string; args: readonly unknown[]} {
  const ts: unknown[] = [];
  const ps: unknown[] = [];
  const qs: unknown[] = [];
  for (const b of bundles) {
    if (b.kind === "transact") ts.push({proof: b.proof, inputs: b.inputs, ext: b.ext});
    else if (b.kind === "pay") ps.push({proof: b.proof, inputs: b.inputs, ext: b.ext, opts: b.opts});
    else if (b.kind === "policyPay") qs.push({proof: b.proof, inputs: b.inputs, ext: b.ext, opts: b.opts});
    else throw new Error(`a ${b.kind} bundle can't be batched`);
  }
  return {functionName: "batch", args: [ts, ps, qs]};
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

// ---------------------------------------------------------------------------
// Refunds and escrow (PaymentBook)
// ---------------------------------------------------------------------------

async function bookWrite(wallet: WalletClient, client: PublicClient, pool: Address, functionName: string, args: readonly unknown[]) {
  const book = (await client.readContract({address: pool, abi: shieldedPoolAbi, functionName: "paymentBook"})) as Address;
  const hash = await wallet.writeContract({
    address: book, abi: paymentBookAbi, functionName: functionName as never, args: args as never,
    account: wallet.account!, chain: wallet.chain,
  });
  const r = await client.waitForTransactionReceipt({hash});
  if (r.status !== "success") throw new Error(`book.${functionName} reverted (${hash})`);
  return {hash, gasUsed: r.gasUsed};
}

/** Merchant: refund `amount` of a REFUNDABLE payment (approves the book for exactly that). */
export async function merchantRefund(wallet: WalletClient, client: PublicClient, pool: Address, p: PaymentRecordView, amount: bigint) {
  const book = (await client.readContract({address: pool, abi: shieldedPoolAbi, functionName: "paymentBook"})) as Address;
  const approveAbi = [{type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{name: "s", type: "address"}, {name: "a", type: "uint256"}], outputs: [{type: "bool"}]}] as const;
  const h = await wallet.writeContract({address: p.record.token, abi: approveAbi, functionName: "approve", args: [book, amount], account: wallet.account!, chain: wallet.chain});
  await client.waitForTransactionReceipt({hash: h});
  return bookWrite(wallet, client, pool, "refund", [p.id, p.record, amount]);
}

/** Merchant: settle an escrow, keeping `amount - refundAmount`. */
export async function claimEscrow(wallet: WalletClient, client: PublicClient, pool: Address, p: PaymentRecordView, refundAmount = 0n) {
  return bookWrite(wallet, client, pool, "claimEscrow", [p.id, p.record, refundAmount]);
}

/** Payer (from any address, e.g. a relayer's): release an escrow to the merchant. */
export async function submitEscrowRelease(wallet: WalletClient, client: PublicClient, pool: Address, a: EscrowAction) {
  return bookWrite(wallet, client, pool, "releaseEscrow", [a.id, a.record, a.secret, a.otherHash]);
}

/** Payer: dispute an escrow (needs an arbiter, before claimableAt). */
export async function submitEscrowDispute(wallet: WalletClient, client: PublicClient, pool: Address, a: EscrowAction) {
  return bookWrite(wallet, client, pool, "disputeEscrow", [a.id, a.record, a.secret, a.otherHash]);
}

/** Arbiter: resolve a dispute, paying the merchant `toMerchant` and refunding the rest. */
export async function resolveEscrow(wallet: WalletClient, client: PublicClient, pool: Address, p: PaymentRecordView, toMerchant: bigint) {
  return bookWrite(wallet, client, pool, "resolveEscrow", [p.id, p.record, toMerchant]);
}

/** Anyone, from expiresAt: return an unclaimed/unresolved escrow to the payer. */
export async function expireEscrow(wallet: WalletClient, client: PublicClient, pool: Address, p: PaymentRecordView) {
  return bookWrite(wallet, client, pool, "expireEscrow", [p.id, p.record]);
}
