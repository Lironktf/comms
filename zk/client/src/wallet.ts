import type {Address, Hex} from "viem";
import type {InputMap} from "@noir-lang/noir_js";
import {
  adminPk as adminPkOf, budgetCommitment, noteCore, noteInner, nullifier, policyHash, type PolicyParams,
} from "./hashes.js";
import {addressToField, fieldToAddress, randomField, toHex32} from "./field.js";
import {addressOf, type AdminKeys, type ShieldedAddress, type SpendingKeys} from "./keys.js";
import {commitmentOf, encryptNote, newNote, tryDecryptCore, tryDecryptNote, type AnyNote, type BudgetNote, type Note} from "./notes.js";
import type {PoolSync} from "./chain.js";
import type {AspProvider} from "./asp.js";
import type {VendorTreeSync} from "./vendors.js";
import type {Prover} from "./prover.js";
import {
  authorizeExtra, computeContext, DIRECT_PAYMENT, escrowSecrets, KIND, PAY_MODE, payExtra, swapExtra, ZERO_ADDRESS, ZERO_BYTES32,
  type ExtData, type Kind, type PayOptions,
} from "./context.js";
import type {PaymentRecordView} from "./chain.js";

// ---------------------------------------------------------------------------
// Bundles: everything a submitter (relayer / facilitator / merchant) needs. They contain
// no secrets: proof + public inputs + bound ext data.
// ---------------------------------------------------------------------------

export interface TransactInputs {
  root: bigint;
  aspRoot: bigint;
  nullifiers: readonly [bigint, bigint];
  outCommitments: readonly [bigint, bigint];
  publicAmount: bigint;
  fee: bigint;
  token: Address;
  recipient: Address;
}

export interface PolicyInputs {
  root: bigint;
  aspRoot: bigint;
  vendorRoot: bigint;
  vendorChecked: boolean;
  nullifiers: readonly [bigint, bigint];
  budgetNullifier: bigint;
  changeCommitment: bigint;
  newBudgetCommitment: bigint;
  /** core of the agent's refund note (same owner/policy/label; circuit-constrained) */
  refundCore: bigint;
  amount: bigint;
  fee: bigint;
  token: Address;
  recipient: Address;
  timestamp: bigint;
}

export interface Authorization3009 {
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface SwapParams {
  adapter: Address;
  tokenOut: Address;
  minAmountOut: bigint;
  data: Hex;
}

export type Bundle =
  | {kind: "transact"; proof: Hex; inputs: TransactInputs; ext: ExtData}
  | {kind: "pay"; proof: Hex; inputs: TransactInputs; ext: ExtData; opts: PayOptions}
  | {kind: "policyPay"; proof: Hex; inputs: PolicyInputs; ext: ExtData; opts: PayOptions}
  | {kind: "initBudget"; proof: Hex; budgetCommitment: bigint; timestamp: bigint; ext: ExtData}
  | {kind: "authorize"; proof: Hex; inputs: TransactInputs; ext: ExtData; auth: Authorization3009}
  | {kind: "swap"; proof: Hex; inputs: TransactInputs; ext: ExtData; swap: SwapParams};

export interface RagequitBundle {
  proof: Hex;
  root: bigint;
  nullifier: bigint;
  amount: bigint;
  token: Address;
  label: bigint;
}

/**
 * How a payment settles.
 *   direct      merchant paid now, final (the default)
 *   refundable  merchant paid now; it can later refund (part of) it to you privately
 *   escrow      the pool's PaymentBook holds it. You release it (or, with an arbiter, dispute it
 *               before `claimAfterSeconds`); the merchant can claim after `claimAfterSeconds`;
 *               after `expireAfterSeconds` an unclaimed escrow comes back to you.
 */
export type PaymentTerms =
  | {mode: "direct"}
  | {mode: "refundable"}
  | {mode: "escrow"; claimAfterSeconds: bigint; expireAfterSeconds: bigint; arbiter?: Address};

/** What the payer needs to act on an escrow; anyone may submit it (use a relayer or fresh address). */
export interface EscrowAction {
  id: bigint;
  record: PaymentRecordView["record"];
  secret: Hex;
  otherHash: Hex;
}

/** Who submits, and what they charge. Fee is paid from the spent notes, inside the proof. */
export interface FeeSpec {
  fee: bigint;
  feeRecipient: Address;
}

export interface OwnedNote {
  note: AnyNote;
  commitment: bigint;
  leafIndex: number;
  nullifier: bigint;
  spent: boolean;
}

const NOTE_DEPTH = 20;
const zeroPath = () => Array.from({length: NOTE_DEPTH}, () => 0n);
const s = (x: bigint | number) => x.toString();
const arr = (xs: readonly bigint[]) => xs.map(s);

function policyToInput(p: PolicyParams | null): InputMap {
  const z = p ?? {adminPk: 0n, token: 0n, maxPerPayment: 0n, maxFee: 0n, periodBudget: 0n, periodSeconds: 0n, minVendorLevel: 0n, categoryMask: 0n, requireVerifiedVendor: false};
  return {
    admin_pk: s(z.adminPk), token: s(z.token), max_per_payment: s(z.maxPerPayment), max_fee: s(z.maxFee),
    period_budget: s(z.periodBudget), period_seconds: s(z.periodSeconds), min_vendor_level: s(z.minVendorLevel),
    category_mask: s(z.categoryMask), require_verified_vendor: z.requireVerifiedVendor,
  };
}

export interface WalletOptions {
  keys: SpendingKeys;
  sync: PoolSync;
  chainId: bigint;
  pool: Address;
  prover: Prover;
  asp: AspProvider;
  /** required for agent (policy) wallets */
  vendors?: VendorTreeSync;
  /** policy this wallet's notes are bound to (agents), or null for a plain wallet */
  policy?: PolicyParams | null;
  /** the policy admin key: lets a human spend/sweep an agent's policy notes */
  admin?: AdminKeys;
  /** clock for deadlines/timestamps (defaults to the latest block's timestamp) */
  now?: () => Promise<bigint>;
}

/**
 * A shielded wallet. Holds keys, finds its notes in the pool's event log, and builds proofs.
 *
 *   const w = new ShieldedWallet({...}); await w.refresh();
 *   const {inner, encryptedNote} = w.prepareDeposit(usdc, 100_000000n);   // then pool.deposit(...)
 *   const bundle = await w.preparePayment({token: usdc, amount: 5_000000n, recipient: merchant, ...fee});
 *   // hand `bundle` to a relayer / x402 facilitator: it calls pool.transact and the merchant is paid.
 */
export class ShieldedWallet {
  readonly keys: SpendingKeys;
  readonly notes: OwnedNote[] = [];
  private scanned = 0;
  private readonly policy: PolicyParams | null;
  readonly policyId: bigint;

  constructor(readonly opts: WalletOptions) {
    this.keys = opts.keys;
    this.policy = opts.policy ?? null;
    this.policyId = this.policy ? policyHash(this.policy) : 0n;
  }

  get address(): ShieldedAddress {
    return addressOf(this.keys);
  }

  /** Sync the pool, trial-decrypt new leaves, mark spent notes. */
  async refresh(): Promise<void> {
    await this.opts.sync.sync();
    const leaves = this.opts.sync.leaves;
    for (; this.scanned < leaves.length; this.scanned++) {
      const l = leaves[this.scanned]!;
      if (l.encrypted.length <= 2) continue;
      const note = tryDecryptNote(Buffer.from(l.encrypted.slice(2), "hex"), this.keys, l.commitment, l.hints);
      if (!note) continue;
      this.notes.push({
        note, commitment: l.commitment, leafIndex: l.leafIndex,
        nullifier: nullifier(this.keys.nk, l.commitment, BigInt(l.leafIndex)), spent: false,
      });
    }
    for (const n of this.notes) n.spent = this.opts.sync.nullifiers.has(n.nullifier);
  }

  unspent(): OwnedNote[] {
    return this.notes.filter((n) => !n.spent);
  }

  /** Spendable value notes of `token` under `policy` (0 = plain notes). */
  valueNotes(token: Address, policy = this.policyId): (OwnedNote & {note: Note})[] {
    return this.unspent().filter(
      (n): n is OwnedNote & {note: Note} =>
        n.note.kind === "note" && n.note.token === addressToField(token) && n.note.policy === policy && n.note.amount > 0n,
    );
  }

  balance(token: Address, policy = this.policyId): bigint {
    return this.valueNotes(token, policy).reduce((a, n) => a + n.note.amount, 0n);
  }

  budgetNote(): (OwnedNote & {note: BudgetNote}) | undefined {
    return this.unspent().find(
      (n): n is OwnedNote & {note: BudgetNote} => n.note.kind === "budget" && n.note.policy === this.policyId,
    );
  }

  protected async now(): Promise<bigint> {
    if (this.opts.now) return this.opts.now();
    const b = await this.opts.sync.client.getBlock();
    return b.timestamp;
  }

  // -------------------------------------------------------------------------
  // Deposit
  // -------------------------------------------------------------------------

  /** Build a deposit for yourself (or, with `to` + `policy`, directly into an agent's policy). */
  prepareDeposit(token: Address, amount: bigint, opts: {to?: ShieldedAddress; policy?: bigint} = {}) {
    const to = opts.to ?? this.address;
    // label is assigned onchain; the ciphertext carries 0 and the wallet fills it in from
    // the Deposited event when it finds the note.
    const note = newNote({amount, token: addressToField(token), label: 0n, owner: to.owner, policy: opts.policy ?? 0n});
    return {
      inner: noteInner(note.owner, note.blinding, note.policy),
      encryptedNote: `0x${Buffer.from(encryptNote(note, to)).toString("hex")}` as Hex,
      note,
    };
  }

  // -------------------------------------------------------------------------
  // Plain spends (transact circuit)
  // -------------------------------------------------------------------------

  /** Pay a public address (merchant, or yourself = withdraw). Merchant gets `amount` in this tx. */
  async preparePayment(
    p: {token: Address; amount: bigint; recipient: Address; requestId?: Hex; deadline?: bigint; terms?: PaymentTerms} & Partial<FeeSpec>,
  ): Promise<Bundle> {
    if (p.amount <= 0n) throw new Error("amount must be > 0");
    const common = {
      token: p.token, publicAmount: p.amount, recipient: p.recipient, fee: p.fee ?? 0n,
      feeRecipient: p.feeRecipient ?? ZERO_ADDRESS, requestId: p.requestId ?? ZERO_BYTES32, deadline: p.deadline,
    };
    if (!p.terms || p.terms.mode === "direct") return this.buildTransact({...common, kind: KIND.TRANSACT});
    // refundable / escrow: deferred-mode transact whose out1 is our refund-note core
    return this.buildTransact({...common, kind: KIND.PAY, deferredOut: {token: p.token}, terms: p.terms});
  }

  /** Our refundable/escrowed payments (recognised by decrypting their refund ciphertext). */
  payments(): PaymentRecordView[] {
    const mine: PaymentRecordView[] = [];
    for (const r of this.opts.sync.payments.values()) {
      if (r.encryptedRefund.length <= 2) continue;
      const note = tryDecryptCore(Buffer.from(r.encryptedRefund.slice(2), "hex"), this.keys, r.record.refundCore);
      if (note) mine.push(r);
    }
    return mine;
  }

  /** Release one of our escrows to the merchant (submit with submitEscrowRelease, from any address). */
  escrowRelease(id: bigint): EscrowAction {
    const r = this.ownPayment(id);
    const sec = escrowSecrets(this.keys.sk, r.record.refundCore);
    return {id, record: r.record, secret: sec.release, otherHash: sec.disputeHash};
  }

  /** Dispute one of our escrows (needs an arbiter; before claimableAt). */
  escrowDispute(id: bigint): EscrowAction {
    const r = this.ownPayment(id);
    const sec = escrowSecrets(this.keys.sk, r.record.refundCore);
    return {id, record: r.record, secret: sec.dispute, otherHash: sec.releaseHash};
  }

  private ownPayment(id: bigint): PaymentRecordView {
    const r = this.payments().find((x) => x.id === id);
    if (!r) throw new Error(`payment ${id} is not ours (or not synced yet)`);
    if (r.record.mode !== PAY_MODE.ESCROW) throw new Error("not an escrow payment");
    return r;
  }

  /** PayOptions for `terms`, given our refund core and its ciphertext. */
  protected async payOptions(terms: PaymentTerms | undefined, refundCore: bigint, encryptedRefund: Hex): Promise<PayOptions> {
    if (!terms || terms.mode === "direct") return DIRECT_PAYMENT;
    if (terms.mode === "refundable") return {...DIRECT_PAYMENT, mode: PAY_MODE.REFUNDABLE, encryptedRefund};
    if (terms.expireAfterSeconds <= terms.claimAfterSeconds) throw new Error("escrow must expire after it becomes claimable");
    const now = await this.now();
    return {
      mode: PAY_MODE.ESCROW,
      arbiter: terms.arbiter ?? ZERO_ADDRESS,
      claimableAt: now + terms.claimAfterSeconds,
      expiresAt: now + terms.expireAfterSeconds,
      payerAuth: escrowSecrets(this.keys.sk, refundCore).payerAuth,
      encryptedRefund,
    };
  }

  /** Private transfer to another shielded address. Nothing about it is public except that a spend happened. */
  async prepareTransfer(p: {token: Address; amount: bigint; to: ShieldedAddress; policy?: bigint; deadline?: bigint} & Partial<FeeSpec>): Promise<Bundle> {
    return this.buildTransact({
      token: p.token, publicAmount: 0n, recipient: ZERO_ADDRESS, fee: p.fee ?? 0n,
      feeRecipient: p.feeRecipient ?? ZERO_ADDRESS, requestId: ZERO_BYTES32, deadline: p.deadline, kind: KIND.TRANSACT,
      privateOut: {amount: p.amount, to: p.to, policy: p.policy ?? 0n},
    });
  }

  /** Path B: reserve `amount` for ONE standard EIP-3009 transfer from the pool to `to`. */
  async prepareAuthorization(p: {token: Address; amount: bigint; to: Address; validAfter: bigint; validBefore: bigint; nonce: Hex; deadline?: bigint} & Partial<FeeSpec>): Promise<Bundle> {
    const auth = {validAfter: p.validAfter, validBefore: p.validBefore, nonce: p.nonce};
    const b = await this.buildTransact({
      token: p.token, publicAmount: p.amount, recipient: p.to, fee: p.fee ?? 0n,
      feeRecipient: p.feeRecipient ?? ZERO_ADDRESS, requestId: ZERO_BYTES32, deadline: p.deadline, kind: KIND.AUTHORIZE,
      extra: authorizeExtra(auth.validAfter, auth.validBefore, auth.nonce), deferredOut: {token: p.token},
    });
    if (b.kind !== "transact") throw new Error("unreachable");
    return {kind: "authorize", proof: b.proof, inputs: b.inputs, ext: b.ext, auth};
  }

  /** Private swap: spend `amountIn` of `token`, receive the output as a new note of `swap.tokenOut`. */
  async prepareSwap(p: {token: Address; amountIn: bigint; swap: SwapParams; deadline?: bigint} & Partial<FeeSpec>): Promise<Bundle> {
    const b = await this.buildTransact({
      token: p.token, publicAmount: p.amountIn, recipient: p.swap.adapter, fee: p.fee ?? 0n,
      feeRecipient: p.feeRecipient ?? ZERO_ADDRESS, requestId: ZERO_BYTES32, deadline: p.deadline, kind: KIND.SWAP,
      extra: swapExtra(p.swap.adapter, p.swap.tokenOut, p.swap.minAmountOut, p.swap.data), deferredOut: {token: p.swap.tokenOut},
    });
    if (b.kind !== "transact") throw new Error("unreachable");
    return {kind: "swap", proof: b.proof, inputs: b.inputs, ext: b.ext, swap: p.swap};
  }

  /**
   * Core 2-in-2-out builder. Picks up to two notes sharing ONE deposit label (all notes of
   * a transaction must share a label: that is how deposit lineage survives spends for the
   * association set), pads with a zero-value dummy, and creates change back to us.
   */
  private async buildTransact(p: {
    token: Address;
    publicAmount: bigint;
    recipient: Address;
    fee: bigint;
    feeRecipient: Address;
    requestId: Hex;
    deadline?: bigint;
    kind: Kind;
    extra?: Hex;
    privateOut?: {amount: bigint; to: ShieldedAddress; policy: bigint};
    deferredOut?: {token: Address};
    terms?: PaymentTerms;
  }): Promise<Bundle> {
    await this.refresh();
    const policyId = this.policyId;
    if (policyId !== 0n && !this.opts.admin) {
      throw new Error("policy-bound notes can only be spent with policy_pay (agent) or with the admin key");
    }
    const privateAmount = p.privateOut?.amount ?? 0n;
    const need = p.publicAmount + p.fee + privateAmount;
    const inputs = this.selectInputs(p.token, need, policyId);
    const label = (inputs[0]!.note as Note).label;
    const total = inputs.reduce((a, n) => a + (n.note as Note).amount, 0n);
    const change = total - need;
    const tokenF = addressToField(p.token);

    // outputs: [change to self, private recipient | dummy | deferred core]
    const self = this.address;
    const out0 = newNote({amount: change, token: tokenF, label, owner: self.owner, policy: policyId});
    let out1: Note;
    let out1To: ShieldedAddress = self;
    if (p.privateOut) {
      out1 = newNote({amount: p.privateOut.amount, token: tokenF, label, owner: p.privateOut.to.owner, policy: p.privateOut.policy});
      out1To = p.privateOut.to;
    } else if (p.deferredOut) {
      // amount 0 in the circuit; the contract sets it (refund value / swap output)
      out1 = newNote({amount: 0n, token: addressToField(p.deferredOut.token), label, owner: self.owner, policy: policyId});
    } else {
      out1 = newNote({amount: 0n, token: tokenF, label, owner: self.owner, policy: policyId});
    }
    const deferred = !!p.deferredOut;
    const outCommitments = [
      commitmentOf(out0),
      deferred ? noteCore(label, noteInner(out1.owner, out1.blinding, out1.policy)) : commitmentOf(out1),
    ] as const;

    // pay(): the refund note's ciphertext travels in PayOptions (emitted by the book), not ext
    const opts = p.terms ? await this.payOptions(p.terms, outCommitments[1], hex(encryptNote(out1, self))) : undefined;
    const ext: ExtData = {
      feeRecipient: p.feeRecipient,
      requestId: p.requestId,
      deadline: p.deadline ?? (await this.now()) + 600n,
      encryptedOutput0: hex(encryptNote(out0, self)),
      encryptedOutput1: opts ? "0x" : hex(encryptNote(out1, out1To)),
    };
    const context = computeContext(this.opts.chainId, this.opts.pool, p.kind, ext, opts ? payExtra(opts) : p.extra);

    const {padded, nfs} = this.padInputs(inputs, label, tokenF, policyId);
    const root = this.opts.sync.root;
    const asp = await this.opts.asp.proofFor(label);
    const tree = this.opts.sync.tree;

    const witness: InputMap = {
      root: s(root), asp_root: s(asp.root), nullifiers: arr(nfs), out_commitments: arr(outCommitments),
      public_amount: s(p.publicAmount), fee: s(p.fee), token: s(tokenF), recipient: s(addressToField(p.recipient)),
      deferred, context: s(context),
      sk: s(this.keys.sk), label: s(label), asp_index: s(asp.index), asp_path: arr(asp.path),
      policy: s(policyId), policy_params: policyToInput(this.policy),
      admin_sk: s(policyId !== 0n ? this.opts.admin!.adminSk : 0n),
      in_amounts: padded.map((n) => s(n.note.amount)),
      in_blindings: padded.map((n) => s(n.note.blinding)),
      in_indices: padded.map((n) => s(n.leafIndex)),
      in_paths: padded.map((n) => (n.real ? arr(tree.path(n.leafIndex)) : arr(zeroPath()))),
      out_amounts: [s(out0.amount), s(deferred ? 0n : out1.amount)],
      out_owners: [s(out0.owner), s(out1.owner)],
      out_blindings: [s(out0.blinding), s(out1.blinding)],
      out_policies: [s(out0.policy), s(out1.policy)],
    };
    const proof = await this.opts.prover.prove("transact", witness);
    const pub: TransactInputs = {
      root, aspRoot: asp.root, nullifiers: [nfs[0]!, nfs[1]!], outCommitments,
      publicAmount: p.publicAmount, fee: p.fee, token: p.token, recipient: p.recipient,
    };
    if (opts) return {kind: "pay", proof: proof.proof, inputs: pub, ext, opts};
    return {kind: "transact", proof: proof.proof, inputs: pub, ext};
  }

  protected selectInputs(token: Address, need: bigint, policy: bigint): (OwnedNote & {note: Note})[] {
    const notes = this.valueNotes(token, policy);
    const byLabel = new Map<bigint, (OwnedNote & {note: Note})[]>();
    for (const n of notes) byLabel.set(n.note.label, [...(byLabel.get(n.note.label) ?? []), n]);
    let best: (OwnedNote & {note: Note})[] | null = null;
    for (const group of byLabel.values()) {
      const sorted = [...group].sort((a, b) => (a.note.amount < b.note.amount ? -1 : 1));
      // smallest single note that covers it, else the two largest
      const single = sorted.find((n) => n.note.amount >= need);
      const pick = single ? [single] : sorted.slice(-2);
      const sum = pick.reduce((a, n) => a + n.note.amount, 0n);
      if (sum >= need && (!best || pick.length < best.length)) best = pick;
    }
    if (!best) {
      const total = notes.reduce((a, n) => a + n.note.amount, 0n);
      throw new Error(
        total >= need
          ? "funds are split across deposits/notes that can't be combined in one 2-input spend; consolidate first"
          : `insufficient shielded balance: have ${total}, need ${need}`,
      );
    }
    return best;
  }

  private padInputs(inputs: (OwnedNote & {note: Note})[], label: bigint, token: bigint, policy: bigint) {
    const padded: {note: Note; leafIndex: number; real: boolean}[] = inputs.map((n) => ({note: n.note, leafIndex: n.leafIndex, real: true}));
    while (padded.length < 2) {
      padded.push({note: newNote({amount: 0n, token, label, owner: this.keys.owner, policy}), leafIndex: 0, real: false});
    }
    const nfs = padded.map((n) => nullifier(this.keys.nk, commitmentOf(n.note), BigInt(n.leafIndex)));
    return {padded, nfs};
  }

  // -------------------------------------------------------------------------
  // Ragequit
  // -------------------------------------------------------------------------

  async prepareRagequit(owned: OwnedNote): Promise<RagequitBundle> {
    if (owned.note.kind !== "note") throw new Error("only value notes can ragequit");
    await this.refresh();
    const n = owned.note;
    const root = this.opts.sync.root;
    const proof = await this.opts.prover.prove("ragequit", {
      root: s(root), nullifier: s(owned.nullifier), amount: s(n.amount), token: s(n.token), label: s(n.label),
      sk: s(this.keys.sk), blinding: s(n.blinding), policy: s(n.policy), leaf_index: s(owned.leafIndex),
      path: arr(this.opts.sync.tree.path(owned.leafIndex)),
    });
    return {proof: proof.proof, root, nullifier: owned.nullifier, amount: n.amount, token: fieldToAddress(n.token), label: n.label};
  }
}

/**
 * An AGENT's wallet: notes bound to a spending policy. It can only pay verified Grayr
 * vendors, within its caps, consuming its private budget note each time.
 */
export class AgentWallet extends ShieldedWallet {
  /** `vendors` is required iff policy.requireVerifiedVendor */
  constructor(opts: WalletOptions & {policy: PolicyParams; vendors?: VendorTreeSync}) {
    super(opts);
  }

  /**
   * Pay a verified merchant under the agent's policy. The client pre-checks the policy so the
   * agent gets a readable error; `unsafeSkipPolicyPrecheck` disables those checks (tests use it
   * to show that the CIRCUIT itself refuses: the client is a convenience, not the enforcement).
   */
  async preparePolicyPayment(
    p: {amount: bigint; recipient: Address; requestId?: Hex; deadline?: bigint; terms?: PaymentTerms; unsafeSkipPolicyPrecheck?: boolean} &
      Partial<FeeSpec>,
  ): Promise<Bundle> {
    const policy = this.opts.policy!;
    const token = fieldToAddress(policy.token);
    const fee = p.fee ?? 0n;
    await this.refresh();
    const checkVendor = policy.requireVerifiedVendor;
    if (checkVendor) await this.opts.vendors!.sync();
    const budget = this.budgetNote();
    if (!budget) throw new Error("agent has no budget note (the policy admin must run initBudget)");
    const now = await this.now();
    const periodNow = now / policy.periodSeconds;
    const available = periodNow > budget.note.period ? policy.periodBudget : budget.note.remaining;
    const vendors = this.opts.vendors;
    // No vendor requirement: an all-zero vendor witness, root 0 (the circuit skips the checks).
    const NO_VENDOR = {level: 0, categories: 0n, expiry: 0n, leafIndex: 0, root: 0n, path: zeroPath()};
    let vendor: {level: number; categories: bigint; expiry: bigint; leafIndex: number; root: bigint; path: bigint[]};
    if (!checkVendor) {
      if (!p.unsafeSkipPolicyPrecheck) {
        if (p.amount > policy.maxPerPayment) throw new Error(`policy: ${p.amount} exceeds per-payment cap ${policy.maxPerPayment}`);
        if (fee > policy.maxFee) throw new Error(`policy: fee ${fee} exceeds cap ${policy.maxFee}`);
        if (p.amount + fee > available) throw new Error(`policy: over budget (available ${available} this period)`);
      }
      vendor = NO_VENDOR;
    } else if (!vendors) {
      throw new Error("this policy requires verified vendors: pass `vendors` (VendorTreeSync)");
    } else if (!p.unsafeSkipPolicyPrecheck) {
      // Fail fast with a readable reason; the circuit enforces the same rules.
      if (p.amount > policy.maxPerPayment) throw new Error(`policy: ${p.amount} exceeds per-payment cap ${policy.maxPerPayment}`);
      if (fee > policy.maxFee) throw new Error(`policy: fee ${fee} exceeds cap ${policy.maxFee}`);
      if (p.amount + fee > available) throw new Error(`policy: over budget (available ${available} this period)`);
      vendor = vendors.membership(p.recipient, now);
      if (BigInt(vendor.level) < policy.minVendorLevel) throw new Error(`policy: merchant level ${vendor.level} < required ${policy.minVendorLevel}`);
      if (policy.categoryMask !== 0n && (vendor.categories & policy.categoryMask) === 0n) throw new Error("policy: merchant category not allowed");
    } else {
      // No valid leaf for an unverified recipient exists; use any leaf so the CIRCUIT rejects it.
      try {
        vendor = vendors.membership(p.recipient, now);
      } catch {
        const any = vendors.leaves[0]!;
        vendor = {...any, root: vendors.tree.root, path: vendors.tree.path(any.leafIndex)};
      }
    }

    const inputs = this.selectInputs(token, p.unsafeSkipPolicyPrecheck ? 1n : p.amount + fee, this.policyId);
    const label = inputs[0]!.note.label;
    const total = inputs.reduce((a, n) => a + n.note.amount, 0n);
    const tokenF = policy.token;
    const self = this.address;
    const change = newNote({amount: total >= p.amount + fee ? total - p.amount - fee : 0n, token: tokenF, label, owner: self.owner, policy: this.policyId});
    const remaining = available - p.amount - fee;
    const newBudget: BudgetNote = {
      kind: "budget", remaining: remaining < 0n ? 0n : remaining, period: periodNow, owner: self.owner,
      blinding: randomField(), policy: this.policyId,
    };
    // Refund slot: a policy-bound note for us (the circuit forces owner, policy and label), in
    // case the merchant refunds or an escrow comes back. Amount is set onchain.
    const refundNote = newNote({amount: 0n, token: tokenF, label, owner: self.owner, policy: this.policyId});
    const refundCore = noteCore(label, noteInner(refundNote.owner, refundNote.blinding, refundNote.policy));
    const opts = await this.payOptions(p.terms, refundCore, hex(encryptNote(refundNote, self)));
    const ext: ExtData = {
      feeRecipient: p.feeRecipient ?? ZERO_ADDRESS,
      requestId: p.requestId ?? ZERO_BYTES32,
      deadline: p.deadline ?? now + 600n,
      encryptedOutput0: hex(encryptNote(change, self)),
      encryptedOutput1: hex(encryptNote(newBudget, self)),
    };
    const context = computeContext(this.opts.chainId, this.opts.pool, KIND.POLICY_PAY, ext, payExtra(opts));
    const padded: {note: Note; leafIndex: number; real: boolean}[] = inputs.map((n) => ({note: n.note, leafIndex: n.leafIndex, real: true}));
    while (padded.length < 2) padded.push({note: newNote({amount: 0n, token: tokenF, label, owner: self.owner, policy: this.policyId}), leafIndex: 0, real: false});
    const nfs = padded.map((n) => nullifier(this.keys.nk, commitmentOf(n.note), BigInt(n.leafIndex)));
    const root = this.opts.sync.root;
    const asp = await this.opts.asp.proofFor(label);
    const tree = this.opts.sync.tree;
    const changeCm = commitmentOf(change);
    const newBudgetCm = budgetCommitment(newBudget);

    const proof = await this.opts.prover.prove("policy_pay", {
      root: s(root), asp_root: s(asp.root), vendor_root: s(vendor.root), vendor_checked: checkVendor, nullifiers: arr(nfs),
      budget_nullifier: s(budget.nullifier), change_commitment: s(changeCm), new_budget_commitment: s(newBudgetCm),
      refund_core: s(refundCore),
      amount: s(p.amount), fee: s(fee), token: s(tokenF), recipient: s(addressToField(p.recipient)), now: s(now),
      context: s(context),
      sk: s(this.keys.sk), label: s(label), asp_index: s(asp.index), asp_path: arr(asp.path),
      policy_params: policyToInput(policy),
      in_amounts: padded.map((n) => s(n.note.amount)),
      in_blindings: padded.map((n) => s(n.note.blinding)),
      in_indices: padded.map((n) => s(n.leafIndex)),
      in_paths: padded.map((n) => (n.real ? arr(tree.path(n.leafIndex)) : arr(zeroPath()))),
      budget_remaining: s(budget.note.remaining), budget_period: s(budget.note.period), budget_blinding: s(budget.note.blinding),
      budget_index: s(budget.leafIndex), budget_path: arr(tree.path(budget.leafIndex)),
      vendor_level: s(vendor.level), vendor_categories: s(vendor.categories), vendor_expiry: s(vendor.expiry),
      vendor_index: s(vendor.leafIndex), vendor_path: arr(vendor.path),
      change_blinding: s(change.blinding), new_budget_blinding: s(newBudget.blinding), refund_blinding: s(refundNote.blinding),
    });
    return {
      kind: "policyPay",
      proof: proof.proof,
      inputs: {
        root, aspRoot: asp.root, vendorRoot: vendor.root, vendorChecked: checkVendor, nullifiers: [nfs[0]!, nfs[1]!], budgetNullifier: budget.nullifier,
        changeCommitment: changeCm, newBudgetCommitment: newBudgetCm, refundCore, amount: p.amount, fee, token,
        recipient: p.recipient, timestamp: now,
      },
      ext,
      opts,
    };
  }
}

/**
 * The policy ADMIN (the human) creates an agent's budget note. Runs on the human's machine;
 * the agent never sees adminSk. The budget note is encrypted to the agent.
 */
export async function prepareBudgetInit(p: {
  prover: Prover;
  admin: AdminKeys;
  policy: PolicyParams;
  agent: ShieldedAddress;
  chainId: bigint;
  pool: Address;
  timestamp: bigint;
  deadline?: bigint;
}): Promise<Bundle> {
  if (adminPkOf(p.admin.adminSk) !== p.policy.adminPk) throw new Error("admin key does not control this policy");
  const period = p.timestamp / p.policy.periodSeconds;
  const note: BudgetNote = {
    kind: "budget", remaining: p.policy.periodBudget, period, owner: p.agent.owner, blinding: randomField(), policy: policyHash(p.policy),
  };
  const ext: ExtData = {
    feeRecipient: ZERO_ADDRESS, requestId: ZERO_BYTES32, deadline: p.deadline ?? p.timestamp + 600n,
    encryptedOutput0: hex(encryptNote(note, p.agent)), encryptedOutput1: "0x",
  };
  const context = computeContext(p.chainId, p.pool, KIND.BUDGET_INIT, ext);
  const cm = budgetCommitment(note);
  const proof = await p.prover.prove("budget_init", {
    budget_commitment_out: s(cm), now: s(p.timestamp), context: s(context),
    admin_sk: s(p.admin.adminSk), policy_params: policyToInput(p.policy), agent_owner: s(p.agent.owner), blinding: s(note.blinding),
  });
  return {kind: "initBudget", proof: proof.proof, budgetCommitment: cm, timestamp: p.timestamp, ext};
}

const hex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;
export {toHex32};
