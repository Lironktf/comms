import {parseAbiItem, type Address, type Hex, type PublicClient} from "viem";
import {MerkleTree} from "./merkle.js";
import {scanLogs} from "./logs.js";

/**
 * Blocks processed per sync step; each getLogs inside is further split to the RPC's cap
 * (logs.ts). Large on purpose: publicnode and Tenderly answered a 30k-block Base Sepolia range
 * in one call (2026-10-17), and 2,000-block steps cost ~600 requests per startup, which got the
 * demo rate-limited. ASSUMPTION: memory per step stays small at testnet volumes.
 */
const SYNC_WINDOW = 100_000n;

/** One leaf of the note tree as seen onchain. */
export interface LeafRecord {
  commitment: bigint;
  leafIndex: number;
  encrypted: Hex;
  /** onchain-only fields needed to recognise the note (see DecryptHints) */
  hints: {label?: bigint; amount?: bigint; token?: bigint};
  blockNumber: bigint;
}

/** A refundable/escrowed payment, as recorded by the pool's PaymentBook. */
export interface PaymentRecordView {
  id: bigint;
  requestId: Hex;
  record: {
    mode: number;
    vendorChecked: boolean;
    merchant: Address;
    token: Address;
    amount: bigint;
    refundCore: bigint;
    arbiter: Address;
    claimableAt: bigint;
    expiresAt: bigint;
    payerAuth: Hex;
  };
  encryptedRefund: Hex;
  status: "open" | "disputed" | "closed";
  refunded: bigint;
  txHash: Hex;
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
  recorded: parseAbiItem(
    "event PaymentRecorded(uint256 indexed id, address indexed merchant, bytes32 indexed requestId, (uint8 mode, bool vendorChecked, address merchant, address token, uint128 amount, uint256 refundCore, address arbiter, uint64 claimableAt, uint64 expiresAt, bytes32 payerAuth) record, bytes encryptedRefund)",
  ),
  disputed: parseAbiItem("event EscrowDisputed(uint256 indexed id)"),
  closed: parseAbiItem("event EscrowClosed(uint256 indexed id, uint256 toMerchant, uint256 refunded)"),
  refunded: parseAbiItem("event Refunded(uint256 indexed id, uint256 amount, uint256 commitment, uint256 leafIndex)"),
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
  /** refundable/escrowed payments by id (= first nullifier) */
  readonly payments = new Map<bigint, PaymentRecordView>();
  private book: Address | null = null;
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
    // public RPCs cap eth_getLogs ranges: catch up in bounded chunks
    for (;;) {
      const latest = await this.client.getBlockNumber({cacheTime: 0});
      if (latest <= this.lastBlock) return;
      const to = latest - this.lastBlock > SYNC_WINDOW ? this.lastBlock + SYNC_WINDOW : latest;
      await this.syncTo(to, to === latest);
      if (to === latest) return;
    }
  }

  private async syncTo(latest: bigint, verifyRoot: boolean): Promise<void> {
    // cacheTime 0: viem otherwise caches the block number for its polling interval, and a
    // sync right after a tx would silently miss that block.
    const range = {address: this.pool, fromBlock: this.lastBlock + 1n, toBlock: latest} as const;
    if (!this.book) {
      this.book = (await this.client.readContract({
        address: this.pool, abi: [parseAbiItem("function paymentBook() view returns (address)")], functionName: "paymentBook",
      })) as Address;
    }
    const bookRange = {...range, address: this.book};
    const [recs, disps, closes, refs] = await Promise.all([
      scanLogs(this.client, range.fromBlock, range.toBlock, (fromBlock, toBlock) => this.client.getLogs({...bookRange, fromBlock, toBlock, event: EV.recorded})),
      scanLogs(this.client, range.fromBlock, range.toBlock, (fromBlock, toBlock) => this.client.getLogs({...bookRange, fromBlock, toBlock, event: EV.disputed})),
      scanLogs(this.client, range.fromBlock, range.toBlock, (fromBlock, toBlock) => this.client.getLogs({...bookRange, fromBlock, toBlock, event: EV.closed})),
      scanLogs(this.client, range.fromBlock, range.toBlock, (fromBlock, toBlock) => this.client.getLogs({...range, fromBlock, toBlock, event: EV.refunded})),
    ]);
    for (const l of recs) {
      const a = l.args;
      this.payments.set(a.id!, {
        id: a.id!, requestId: a.requestId!, record: {...a.record!, amount: BigInt(a.record!.amount)},
        encryptedRefund: a.encryptedRefund!, status: "open", refunded: 0n, txHash: l.transactionHash!,
      });
    }
    for (const l of disps) {
      const p = this.payments.get(l.args.id!);
      if (p) p.status = "disputed";
    }
    for (const l of closes) {
      const p = this.payments.get(l.args.id!);
      if (p) p.status = "closed";
    }
    const refundByLeaf = new Map<number, {id: bigint; amount: bigint}>();
    for (const l of refs) {
      refundByLeaf.set(Number(l.args.leafIndex!), {id: l.args.id!, amount: l.args.amount!});
      const p = this.payments.get(l.args.id!);
      if (p) {
        p.refunded += l.args.amount!;
        if (p.record.mode === 1 && p.refunded === p.record.amount) p.status = "closed";
      }
    }

    const [cms, nfs, deps, auths, recl, swaps] = await Promise.all([
      scanLogs(this.client, range.fromBlock, range.toBlock, (fromBlock, toBlock) => this.client.getLogs({...range, fromBlock, toBlock, event: EV.commitment})),
      scanLogs(this.client, range.fromBlock, range.toBlock, (fromBlock, toBlock) => this.client.getLogs({...range, fromBlock, toBlock, event: EV.nullifier})),
      scanLogs(this.client, range.fromBlock, range.toBlock, (fromBlock, toBlock) => this.client.getLogs({...range, fromBlock, toBlock, event: EV.deposited})),
      scanLogs(this.client, range.fromBlock, range.toBlock, (fromBlock, toBlock) => this.client.getLogs({...range, fromBlock, toBlock, event: EV.authorized})),
      scanLogs(this.client, range.fromBlock, range.toBlock, (fromBlock, toBlock) => this.client.getLogs({...range, fromBlock, toBlock, event: EV.reclaimed})),
      scanLogs(this.client, range.fromBlock, range.toBlock, (fromBlock, toBlock) => this.client.getLogs({...range, fromBlock, toBlock, event: EV.swapped})),
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
      const rf = refundByLeaf.get(leafIndex);
      const pay = rf && this.payments.get(rf.id);
      if (rf && pay) {
        hints.amount = rf.amount;
        hints.token = BigInt(pay.record.token);
        encrypted = pay.encryptedRefund;
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

    // Root check only at the head: reading old state needs an archive node.
    if (!verifyRoot) return;
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
