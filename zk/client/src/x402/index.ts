/**
 * x402 integration for the shielded pool, built on the official @x402/core v2 interfaces.
 *
 * PATH A: a new `shielded` scheme.
 *   merchant 402 -> accepts [{scheme: "shielded", payTo: M, amount, asset, extra: {pool, feeRecipient, fee}}]
 *   agent        -> PAYMENT-SIGNATURE header = base64(JSON PaymentPayload{payload: proof bundle})
 *   facilitator  -> verify: bundle binds payTo/amount/asset/fee + eth_call simulation (checks the
 *                   proof, roots and nullifiers onchain, free); settle: pool.transact / payWithPolicy,
 *                   which pays M directly in that transaction.
 *   Merchant changes: register ShieldedServerScheme + a facilitator that supports it. No keys,
 *   no decryption: M receives ordinary USDC.
 *
 * PATH B: the pool as a standard `exact` payer (zero merchant changes).
 *   agent -> relayer: pool.authorizeTransfer(proof...) registers ONE EIP-3009 digest
 *   agent -> merchant: an ordinary `exact` payload with from = pool
 *   merchant's UNMODIFIED facilitator -> USDC.transferWithAuthorization(..., bytes sig) ->
 *   USDC asks pool.isValidSignature(digest) (EIP-1271) -> yes, for exactly that transfer.
 */
import type {
  AssetAmount, Network, PaymentPayload, PaymentPayloadResult, PaymentRequirements, Price, SchemeNetworkClient,
  SchemeNetworkFacilitator, SchemeNetworkServer, SettleResponse, SupportedKind, SupportedResponse, VerifyResponse,
} from "@x402/core/types";
import type {FacilitatorClient} from "@x402/core/server";
import type {x402Facilitator} from "@x402/core/facilitator";
import type {Address, Hex, PublicClient} from "viem";
import {fromWire, parseBundle, toWire} from "../serde.js";
import {randomBytes32} from "../context.js";
import type {AgentWallet, Bundle, ShieldedWallet} from "../wallet.js";
import type {Relayer, RelayResult} from "../relayer.js";
import {shortError, uploadBundle} from "../relayer.js";

export const SHIELDED = "shielded";

/** Signature bytes the agent puts in a Path-B `exact` payload. The pool ignores them (it
 *  answers EIP-1271 from its own registry); they just must NOT be 65 bytes, so facilitators
 *  route to USDC's `transferWithAuthorization(..., bytes signature)` overload. */
export const POOL_SIGNATURE: Hex = "0x677261797a6b2e706f6f6c2e65697031323731"; // "grayzk.pool.eip1271"

// ---------------------------------------------------------------------------
// Resource server (merchant) side
// ---------------------------------------------------------------------------

export class ShieldedServerScheme implements SchemeNetworkServer {
  readonly scheme = SHIELDED;
  // @x402/core >= 2.28 requires these two fields on server schemes; 2.19 ignores them.
  readonly defaultAssetTransferMethod = "shielded-pool";
  readonly paymentFlows = {default: {supported: ["upfront"], default: "upfront"}} as const;

  constructor(private readonly opts: {usdc?: Address; usdcDecimals?: number} = {}) {}

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      return {amount: price.amount, asset: price.asset, extra: price.extra ?? {}};
    }
    // "$0.01" / 0.01 -> USDC atomic units
    if (!this.opts.usdc) throw new Error("shielded: give {amount, asset} or configure a USDC address for $ prices");
    const usd = typeof price === "number" ? price : Number(String(price).replace(/^\$/, ""));
    const amount = BigInt(Math.round(usd * 10 ** (this.opts.usdcDecimals ?? 6)));
    return {amount: amount.toString(), asset: this.opts.usdc, extra: {}};
  }

  async enhancePaymentRequirements(req: PaymentRequirements, kind: SupportedKind): Promise<PaymentRequirements> {
    // The facilitator advertises its pool + fee terms in /supported (getExtra below).
    return {...req, extra: {...req.extra, ...(kind.extra ?? {})}};
  }
}

// ---------------------------------------------------------------------------
// Facilitator side (natural home: Grayr)
// ---------------------------------------------------------------------------

export class ShieldedFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = SHIELDED;
  readonly caipFamily = "eip155:*";

  constructor(
    private readonly relayer: Relayer,
    /** publicUrl: where clients reach this facilitator's relayer API (for bundle upload) */
    private readonly opts: {network: Network; token: Address; publicUrl?: string; maxDeadlineSlackSeconds?: number},
  ) {}

  getExtra(_network: Network): Record<string, unknown> {
    const fee = this.relayer.cfg.minFee[this.opts.token.toLowerCase()] ?? this.relayer.cfg.minFee[this.opts.token] ?? 0n;
    const extra: Record<string, unknown> = {pool: this.relayer.cfg.pool, feeRecipient: this.relayer.address, fee: fee.toString()};
    if (this.opts.publicUrl) extra.bundleUploadUrl = `${this.opts.publicUrl.replace(/\/$/, "")}/v1/bundles`;
    return extra;
  }

  getSigners(_network: string): string[] {
    return [this.relayer.address];
  }

  private bind(payload: PaymentPayload, req: PaymentRequirements): {bundle: Bundle} | {error: string} {
    let bundle: Bundle;
    try {
      const ref = payload.payload.bundleRef;
      if (typeof ref === "string") {
        const stored = this.relayer.bundles.get(ref);
        if (!stored) return {error: "unknown or expired bundleRef (upload it to bundleUploadUrl first)"};
        bundle = stored;
      } else {
        bundle = parseBundle(payload.payload.bundle);
      }
    } catch (e) {
      return {error: `malformed bundle: ${(e as Error).message}`};
    }
    if (req.scheme !== SHIELDED) return {error: "wrong scheme"};
    if (req.network !== this.opts.network) return {error: "wrong network"};
    if (String(req.extra?.pool ?? "").toLowerCase() !== this.relayer.cfg.pool.toLowerCase()) return {error: "wrong pool"};
    let recipient: Address, amount: bigint, token: Address;
    if (bundle.kind === "transact") {
      ({recipient, publicAmount: amount, token} = bundle.inputs);
    } else if (bundle.kind === "policyPay") {
      ({recipient, amount, token} = bundle.inputs);
    } else {
      return {error: `bundle kind ${bundle.kind} is not a payment`};
    }
    if (recipient.toLowerCase() !== req.payTo.toLowerCase()) return {error: "proof does not pay payTo"};
    if (amount !== BigInt(req.amount)) return {error: "proof amount != required amount"};
    if (token.toLowerCase() !== req.asset.toLowerCase()) return {error: "proof token != required asset"};
    if (bundle.ext.requestId === `0x${"00".repeat(32)}`) return {error: "payment must bind an x402 request id"};
    const maxDeadline = BigInt(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds + (this.opts.maxDeadlineSlackSeconds ?? 3600));
    if (bundle.ext.deadline > maxDeadline) return {error: "deadline too far in the future"};
    return {bundle};
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const b = this.bind(payload, req);
    if ("error" in b) return {isValid: false, invalidReason: "invalid_payload", invalidMessage: b.error};
    try {
      // fee terms + eth_call simulation: verifies the PROOF onchain (plus roots, nullifiers,
      // association set, vendor root) without spending gas.
      await this.relayer.check(b.bundle);
    } catch (e) {
      return {isValid: false, invalidReason: "invalid_payload", invalidMessage: shortError(e)};
    }
    return {isValid: true, payer: this.relayer.cfg.pool};
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const b = this.bind(payload, req);
    if ("error" in b) return {success: false, errorReason: "invalid_payload", errorMessage: b.error, transaction: "", network: req.network};
    try {
      const r: RelayResult = await this.relayer.relay(b.bundle);
      return {success: true, transaction: r.txHash, network: req.network, payer: this.relayer.cfg.pool};
    } catch (e) {
      return {success: false, errorReason: "unexpected_settle_error", errorMessage: shortError(e), transaction: "", network: req.network};
    }
  }
}

/** Use an in-process x402Facilitator as the resource server's FacilitatorClient. */
export function localFacilitatorClient(f: x402Facilitator): FacilitatorClient {
  return {
    verify: (p, r) => f.verify(p, r),
    settle: (p, r) => f.settle(p, r),
    getSupported: async () => f.getSupported() as unknown as SupportedResponse,
  };
}

// ---------------------------------------------------------------------------
// Client (agent) side
// ---------------------------------------------------------------------------

export interface ShieldedClientOptions {
  /** a plain wallet (transact) or an AgentWallet (policy_pay: policy enforced in-proof) */
  wallet: ShieldedWallet | AgentWallet;
  /** refuse requirements whose facilitator fee exceeds this (atomic units) */
  maxFee: bigint;
}

export class ShieldedClientScheme implements SchemeNetworkClient {
  readonly scheme = SHIELDED;

  constructor(private readonly opts: ShieldedClientOptions) {}

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const pool = String(req.extra?.pool ?? "");
    if (pool.toLowerCase() !== this.opts.wallet.opts.pool.toLowerCase()) throw new Error(`shielded: unknown pool ${pool}`);
    const fee = BigInt(String(req.extra?.fee ?? "0"));
    if (fee > this.opts.maxFee) throw new Error(`shielded: facilitator fee ${fee} exceeds max ${this.opts.maxFee}`);
    const feeRecipient = String(req.extra?.feeRecipient ?? "0x0000000000000000000000000000000000000000") as Address;
    const requestId = randomBytes32();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds);
    const w = this.opts.wallet;
    const bundle =
      "preparePolicyPayment" in w
        ? await (w as AgentWallet).preparePolicyPayment({amount: BigInt(req.amount), recipient: req.payTo as Address, fee, feeRecipient, requestId, deadline})
        : await w.preparePayment({token: req.asset as Address, amount: BigInt(req.amount), recipient: req.payTo as Address, fee, feeRecipient, requestId, deadline});
    // Proof bundles are ~9 KB: too big for an HTTP header once base64'd. If the facilitator
    // offers a bundle store, upload and send only the content id.
    const upload = req.extra?.bundleUploadUrl;
    if (typeof upload === "string" && upload.length) {
      return {x402Version, payload: {bundleRef: await uploadBundle(upload, bundle)}};
    }
    return {x402Version, payload: {bundle: toWire(bundle)}};
  }
}

// ---------------------------------------------------------------------------
// Path B client: an ordinary `exact` payment whose payer is the pool
// ---------------------------------------------------------------------------

export interface PoolExactClientOptions {
  wallet: ShieldedWallet;
  /** registers the authorization onchain BEFORE the payload is sent (relayer HTTP or local) */
  relay: (b: Bundle) => Promise<unknown>;
  feeRecipient: Address;
  fee: bigint;
  publicClient: PublicClient;
}

export class PoolExactClientScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  constructor(private readonly opts: PoolExactClientOptions) {}

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const now = (await this.opts.publicClient.getBlock()).timestamp;
    const validAfter = now - 60n;
    const validBefore = now + BigInt(Math.min(req.maxTimeoutSeconds, 3600));
    const nonce = randomBytes32();
    const bundle = await this.opts.wallet.prepareAuthorization({
      token: req.asset as Address, amount: BigInt(req.amount), to: req.payTo as Address, validAfter, validBefore, nonce,
      fee: this.opts.fee, feeRecipient: this.opts.feeRecipient,
    });
    await this.opts.relay(bundle); // pool.authorizeTransfer is mined: digest registered
    return {
      x402Version,
      payload: {
        signature: POOL_SIGNATURE,
        authorization: {
          from: this.opts.wallet.opts.pool, to: req.payTo, value: req.amount,
          validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce,
        },
      },
    };
  }
}

export {fromWire, toWire};
