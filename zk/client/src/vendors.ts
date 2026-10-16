import {parseAbiItem, type Address, type PublicClient} from "viem";
import {MerkleTree} from "./merkle.js";
import {vendorLeaf} from "./hashes.js";

export interface VendorLeafRecord {
  vendorId: `0x${string}`;
  wallet: Address;
  leaf: bigint;
  leafIndex: number;
  level: number;
  categories: bigint;
  expiry: bigint;
}

export interface VendorMembership extends VendorLeafRecord {
  root: bigint;
  path: bigint[];
}

const PUBLISHED = parseAbiItem(
  "event VendorPublished(bytes32 indexed vendorId, address indexed wallet, uint256 leaf, uint256 leafIndex, uint8 level, uint64 categories, uint64 expiry, uint256 root)",
);

/** Mirrors Grayr's VendorTree (verified merchants) from its events. Public data. */
export class VendorTreeSync {
  readonly tree = new MerkleTree(20);
  readonly leaves: VendorLeafRecord[] = [];
  private lastBlock = -1n;

  constructor(
    readonly client: PublicClient,
    readonly address: Address,
  ) {}

  async sync(): Promise<void> {
    // cacheTime 0: viem otherwise caches the block number for its polling interval, and a
    // sync right after a tx would silently miss that block.
    const latest = await this.client.getBlockNumber({cacheTime: 0});
    if (latest <= this.lastBlock) return;
    const logs = await this.client.getLogs({address: this.address, event: PUBLISHED, fromBlock: this.lastBlock + 1n, toBlock: latest});
    for (const l of logs) {
      const a = l.args;
      const rec: VendorLeafRecord = {
        vendorId: a.vendorId!, wallet: a.wallet!, leaf: a.leaf!, leafIndex: Number(a.leafIndex!),
        level: Number(a.level!), categories: a.categories!, expiry: a.expiry!,
      };
      // Never trust event fields blindly: the leaf must recompute from them.
      if (vendorLeaf(BigInt(rec.wallet), BigInt(rec.level), rec.categories, rec.expiry) !== rec.leaf) {
        throw new Error(`vendor leaf ${rec.leafIndex} does not match its fields`);
      }
      this.tree.insertAt(rec.leafIndex, rec.leaf);
      this.leaves.push(rec);
    }
    this.lastBlock = latest;
  }

  /** Best (latest-expiring, unexpired at `now`) leaf for a merchant wallet. */
  membership(wallet: Address, now: bigint): VendorMembership {
    const cands = this.leaves.filter((l) => l.wallet.toLowerCase() === wallet.toLowerCase() && l.expiry >= now);
    if (!cands.length) throw new Error(`merchant ${wallet} is not a verified vendor (or its leaf expired; call VendorTree.publish)`);
    const best = cands.reduce((a, b) => (b.expiry > a.expiry ? b : a));
    return {...best, root: this.tree.root, path: this.tree.path(best.leafIndex)};
  }
}
