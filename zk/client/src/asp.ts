import {parseAbiItem, type Address, type PublicClient, type WalletClient} from "viem";
import {MerkleTree} from "./merkle.js";
import type {PoolSync} from "./chain.js";
import {associationSetAbi} from "./abi.js";

export interface MembershipProof {
  root: bigint;
  index: number;
  path: bigint[];
}

/** Where a wallet gets "my deposit label is in the association set" Merkle proofs. */
export interface AspProvider {
  proofFor(label: bigint): Promise<MembershipProof>;
}

/**
 * The association set: a Poseidon2 tree whose leaves are approved deposit labels, in a
 * deterministic order (deposit order). Anyone holding the published label list can rebuild
 * it and check the onchain root, which is why the ASP publishes the list's content address.
 */
export class AssociationSet implements AspProvider {
  readonly tree = new MerkleTree(20);
  readonly labels: bigint[];

  constructor(labels: readonly bigint[]) {
    this.labels = [...labels];
    if (this.labels.length) this.tree.insert(this.labels);
  }

  get root(): bigint {
    return this.tree.root;
  }

  has(label: bigint): boolean {
    return this.labels.includes(label);
  }

  async proofFor(label: bigint): Promise<MembershipProof> {
    const index = this.labels.indexOf(label);
    if (index < 0) throw new Error("deposit label is not in the association set (use ragequit to exit publicly)");
    return {root: this.tree.root, index, path: this.tree.path(index)};
  }

  /** Canonical JSON of the label list (what gets content-addressed and published). */
  toJSON(): string {
    return JSON.stringify({version: 1, labels: this.labels.map((l) => l.toString())});
  }
}

/** A screening rule: return a reason to EXCLUDE a deposit, or null to include it. */
export type ScreeningRule = (d: {depositor: Address; token: Address; amount: bigint; label: bigint}) => string | null;

/** Example rule: exclude deposits from a blocklist (e.g. a sanctions list snapshot). */
export function blocklistRule(blocked: Iterable<string>): ScreeningRule {
  const set = new Set([...blocked].map((a) => a.toLowerCase()));
  return (d) => (set.has(d.depositor.toLowerCase()) ? "depositor on blocklist" : null);
}

/**
 * Minimal association-set provider (ASP) service: screens every deposit, rebuilds the
 * approved set, publishes the root onchain. In production the screening is a compliance
 * provider (Chainalysis/TRM-style) and the label list is pinned to IPFS; here the rule is
 * pluggable and the list is served from memory.
 */
export class AspService {
  current = new AssociationSet([]);
  readonly excluded = new Map<bigint, string>();

  constructor(
    private readonly sync: PoolSync,
    private readonly registry: Address,
    private readonly rule: ScreeningRule,
  ) {}

  /** Recompute the set from all deposits; returns true if it changed. */
  async refresh(): Promise<boolean> {
    await this.sync.sync();
    const approved: bigint[] = [];
    const deposits = [...this.sync.deposits.values()].sort((a, b) => a.leafIndex - b.leafIndex);
    for (const d of deposits) {
      const reason = this.rule(d);
      if (reason) this.excluded.set(d.label, reason);
      else approved.push(d.label);
    }
    const next = new AssociationSet(approved);
    const changed = next.root !== this.current.root;
    this.current = next;
    return changed;
  }

  async publish(wallet: WalletClient, publicClient: PublicClient, cid = "inline:" + this.current.labels.length): Promise<`0x${string}`> {
    const hash = await wallet.writeContract({
      address: this.registry,
      abi: associationSetAbi,
      functionName: "publishRoot",
      args: [this.current.root, cid],
      account: wallet.account!,
      chain: wallet.chain,
    });
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  }

  async proofFor(label: bigint): Promise<MembershipProof> {
    return this.current.proofFor(label);
  }
}

export const aspRootPublishedEvent = parseAbiItem(
  "event RootPublished(uint256 indexed version, uint256 indexed root, string cid, uint64 timestamp)",
);
