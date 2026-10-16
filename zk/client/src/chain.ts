import {parseAbiItem, type Address, type Hex, type PublicClient} from "viem";
import {MerkleTree} from "./merkle.js";

/** One leaf of the note tree as seen onchain. */
export interface LeafRecord {
  commitment: bigint;
  leafIndex: number;
  encrypted: Hex;
  /** onchain-only fields needed to recognise the note (see DecryptHints) */
  hints: {label?: bigint; amount?: bigint; token?: bigint};
  blockNumber: bigint;
}

export interface DepositRecord {
  label: bigint;
  depositor: Address;
  token: Address;
  amount: bigint;
  commitment: bigint;
  leafIndex: number;
}

const EV = {
  commitment: parseAbiItem("event NewCommitment(uint256 indexed commitment, uint256 indexed leafIndex, bytes encryptedNote)"),
  nullifier: parseAbiItem("event NewNullifier(uint256 indexed nullifier)"),
  deposited: parseAbiItem(
    "event Deposited(uint256 indexed label, address indexed depositor, address indexed token, uint256 amount, uint256 commitment, uint256 leafIndex)",
  ),
  authorized: parseAbiItem(
    "event TransferAuthorized(bytes32 indexed digest, address indexed to, address indexed token, uint256 value, uint256 validBefore, bytes32 nonce, uint256 refundCore, bytes encryptedRefund)",
  ),
  reclaimed: parseAbiItem("event AuthorizationReclaimed(bytes32 indexed digest, uint256 commitment, uint256 leafIndex)"),
  swapped: parseAbiItem(
    "event Swapped(address indexed adapter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 outLeafIndex)",
  ),
} as const;

/**
 * Rebuilds the pool's public state from its event log alone: the note tree (so we can
 * produce Merkle paths), the nullifier set (so we know what's spent), deposits (labels
 * for ASP + ragequit), and the extra data needed to recognise deferred notes.
 * Nothing here is secret: a relayer, the ASP and every wallet run the same sync.
 */
export class PoolSync {
  readonly tree = new MerkleTree(20);
  readonly leaves: LeafRecord[] = [];
  readonly nullifiers = new Set<bigint>();
  readonly deposits = new Map<bigint, DepositRecord>();
  readonly authorizations = new Map<Hex, {to: Address; token: Address; value: bigint; validBefore: bigint; nonce: Hex; refundCore: bigint; encryptedRefund: Hex; reclaimed: boolean}>();
  private lastBlock: bigint;

  constructor(
    readonly client: PublicClient,
    readonly pool: Address,
    readonly fromBlock = 0n,
  ) {
    this.lastBlock = fromBlock - 1n;
  }

  get root(): bigint {
    return this.tree.root;
  }

  async sync(): Promise<void> {
    // cacheTime 0: viem otherwise caches the block number for its polling interval, and a
    // sync right after a tx would silently miss that block.
    const latest = await this.client.getBlockNumber({cacheTime: 0});
    if (latest <= this.lastBlock) return;
    const range = {address: this.pool, fromBlock: this.lastBlock + 1n, toBlock: latest} as const;
    const [cms, nfs, deps, auths, recl, swaps] = await Promise.all([
      this.client.getLogs({...range, event: EV.commitment}),
      this.client.getLogs({...range, event: EV.nullifier}),
      this.client.getLogs({...range, event: EV.deposited}),
      this.client.getLogs({...range, event: EV.authorized}),
      this.client.getLogs({...range, event: EV.reclaimed}),
      this.client.getLogs({...range, event: EV.swapped}),
    ]);

    for (const l of deps) {
      const a = l.args;
      this.deposits.set(a.label!, {
        label: a.label!, depositor: a.depositor!, token: a.token!, amount: a.amount!,
        commitment: a.commitment!, leafIndex: Number(a.leafIndex!),
      });
    }
    for (const l of auths) {
      const a = l.args;
      this.authorizations.set(a.digest!, {
        to: a.to!, token: a.token!, value: a.value!, validBefore: a.validBefore!, nonce: a.nonce!,
        refundCore: a.refundCore!, encryptedRefund: a.encryptedRefund!, reclaimed: false,
      });
    }
    const swapByLeaf = new Map(swaps.map((l) => [Number(l.args.outLeafIndex!), l.args]));
    const reclaimByLeaf = new Map(recl.map((l) => [Number(l.args.leafIndex!), l.args.digest!]));
    const depositByLeaf = new Map([...this.deposits.values()].map((d) => [d.leafIndex, d]));

    // Logs come back in (block, logIndex) order, so leaf indices are increasing.
    for (const l of cms) {
      const leafIndex = Number(l.args.leafIndex!);
      if (leafIndex > this.tree.size) this.tree.pad(leafIndex - this.tree.size); // empty half of a pair
      this.tree.insertAt(leafIndex, l.args.commitment!);
      const hints: LeafRecord["hints"] = {};
      let encrypted = l.args.encryptedNote!;
      const dep = depositByLeaf.get(leafIndex);
      if (dep) hints.label = dep.label;
      const sw = swapByLeaf.get(leafIndex);
      if (sw) {
        hints.amount = sw.amountOut!;
        hints.token = BigInt(sw.tokenOut!);
      }
      const digest = reclaimByLeaf.get(leafIndex);
      if (digest) {
        const auth = this.authorizations.get(digest);
        if (auth) {
          auth.reclaimed = true;
          hints.amount = auth.value;
          hints.token = BigInt(auth.token);
          encrypted = auth.encryptedRefund;
        }
      }
      this.leaves.push({commitment: l.args.commitment!, leafIndex, encrypted, hints, blockNumber: l.blockNumber});
    }
    // Pairs: every insertion is 2 leaves, so the tree size is always even.
    if (this.tree.size % 2 === 1) this.tree.pad(1);
    for (const l of nfs) this.nullifiers.add(l.args.nullifier!);
    this.lastBlock = latest;

    const onchainRoot = (await this.client.readContract({
      address: this.pool,
      abi: [parseAbiItem("function root() view returns (uint256)")],
      functionName: "root",
      blockNumber: latest,
    })) as bigint;
    if (onchainRoot !== this.tree.root) {
      throw new Error(`tree sync mismatch at block ${latest}: local ${this.tree.root} != onchain ${onchainRoot}`);
    }
  }
}
