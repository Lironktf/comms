/**
 * M1 + M5 end to end on a local anvil, with REAL proofs:
 * deposit -> private pay to a merchant via a relayer -> double-spend rejected -> private
 * transfer -> withdraw -> tampering every bound public input fails -> association set
 * exclusion + ragequit.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {type Address} from "viem";
import {
  approve, erc20Balance, mintUsdc, startDevnet, type Devnet,
} from "../src/devnet.js";
import {AspService, blocklistRule} from "../src/asp.js";
import {PoolSync} from "../src/chain.js";
import {deriveSpendingKeys} from "../src/keys.js";
import {Prover} from "../src/prover.js";
import {ShieldedWallet, type Bundle} from "../src/wallet.js";
import {simulateBundle, submitBundle, submitRagequit} from "../src/pool.js";
import {shieldedPoolAbi} from "../src/abi.js";

const USDC = (x: number) => BigInt(Math.round(x * 1e6));
const seed = (n: number) => new Uint8Array(32).fill(n);

let d: Devnet;
let prover: Prover;
let asp: AspService;
let alice: ShieldedWallet;
let bob: ShieldedWallet;
let mallory: ShieldedWallet;
let merchant: Address;
let relayer: Address;
const ALICE = 1, BOB = 3, RELAYER = 2, MERCHANT = 5, MALLORY = 7;

function walletFor(seedByte: number): ShieldedWallet {
  return new ShieldedWallet({
    keys: deriveSpendingKeys(seed(seedByte)),
    sync: new PoolSync(d.publicClient, d.deployment.pool),
    chainId: 31337n, pool: d.deployment.pool, prover, asp,
  });
}

async function deposit(w: ShieldedWallet, account: number, amount: bigint): Promise<void> {
  await mintUsdc(d, d.address(account), amount);
  await approve(d, account, d.deployment.usdc, d.deployment.pool, amount);
  const dep = w.prepareDeposit(d.deployment.usdc, amount);
  const wc = d.wallet(account);
  const hash = await wc.writeContract({
    address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "deposit",
    args: [d.deployment.usdc, amount, dep.inner, dep.encryptedNote], account: wc.account!, chain: d.chain,
  });
  expect((await d.publicClient.waitForTransactionReceipt({hash})).status).toBe("success");
}

async function publishAsp(): Promise<void> {
  if (await asp.refresh()) await asp.publish(d.wallet(0), d.publicClient);
}

async function expectRevert(p: Promise<unknown>, err: string): Promise<void> {
  await expect(p).rejects.toThrow(new RegExp(err));
}

beforeAll(async () => {
  d = await startDevnet(8611);
  prover = new Prover();
  merchant = d.address(MERCHANT);
  relayer = d.address(RELAYER);
  asp = new AspService(new PoolSync(d.publicClient, d.deployment.pool), d.deployment.associationSet, blocklistRule([d.address(MALLORY)]));
  alice = walletFor(1);
  bob = walletFor(2);
  mallory = walletFor(3);
});

afterAll(async () => {
  await prover?.destroy();
  d?.stop();
});

describe("shielded pool on anvil (real proofs)", () => {
  let payBundle: Bundle;

  it("deposits and finds its note by trial decryption", async () => {
    await deposit(alice, ALICE, USDC(100));
    await publishAsp();
    await alice.refresh();
    expect(alice.balance(d.deployment.usdc)).toBe(USDC(100));
    expect(alice.notes[0]!.note.kind === "note" && alice.notes[0]!.note.label).not.toBe(0n);
  });

  it("pays a merchant privately; the pool pays the merchant directly, relayer gets the fee", async () => {
    const before = await erc20Balance(d, d.deployment.usdc, merchant);
    payBundle = await alice.preparePayment({
      token: d.deployment.usdc, amount: USDC(5), recipient: merchant, fee: USDC(0.1), feeRecipient: relayer,
      requestId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    });
    // relayer: simulate (free, checks the proof onchain), then submit from ITS address
    await simulateBundle(d.publicClient, d.deployment.pool, payBundle, relayer);
    const {gasUsed} = await submitBundle(d.wallet(RELAYER), d.publicClient, d.deployment.pool, payBundle);
    console.log(`  transact (pay) gas: ${gasUsed}`);
    expect(await erc20Balance(d, d.deployment.usdc, merchant)).toBe(before + USDC(5));
    expect(await erc20Balance(d, d.deployment.usdc, relayer)).toBe(USDC(0.1));
    await alice.refresh();
    expect(alice.balance(d.deployment.usdc)).toBe(USDC(94.9));
  });

  it("rejects a replay of the same payment (nullifiers already spent)", async () => {
    await expectRevert(simulateBundle(d.publicClient, d.deployment.pool, payBundle, relayer), "NullifierSpent");
  });

  it("private transfer: Bob receives a note nobody else can see", async () => {
    const b = await alice.prepareTransfer({token: d.deployment.usdc, amount: USDC(10), to: bob.address});
    await submitBundle(d.wallet(RELAYER), d.publicClient, d.deployment.pool, b);
    await bob.refresh();
    await alice.refresh();
    expect(bob.balance(d.deployment.usdc)).toBe(USDC(10));
    expect(alice.balance(d.deployment.usdc)).toBe(USDC(84.9));
  });

  it("Bob withdraws to an address chosen at withdrawal time", async () => {
    const to = d.address(BOB);
    const b = await bob.preparePayment({token: d.deployment.usdc, amount: USDC(4), recipient: to});
    await submitBundle(d.wallet(RELAYER), d.publicClient, d.deployment.pool, b);
    expect(await erc20Balance(d, d.deployment.usdc, to)).toBe(USDC(4));
    await bob.refresh();
    expect(bob.balance(d.deployment.usdc)).toBe(USDC(6));
  });

  describe("tampering with any bound field invalidates the proof", () => {
    let fresh: Extract<Bundle, {kind: "transact"}>;
    beforeAll(async () => {
      fresh = (await alice.preparePayment({
        token: d.deployment.usdc, amount: USDC(1), recipient: merchant, fee: USDC(0.01), feeRecipient: relayer,
        requestId: "0x2222222222222222222222222222222222222222222222222222222222222222",
      })) as Extract<Bundle, {kind: "transact"}>;
      await simulateBundle(d.publicClient, d.deployment.pool, fresh, relayer); // untampered is valid
    });
    const sim = (b: Bundle) => simulateBundle(d.publicClient, d.deployment.pool, b, relayer);
    it("recipient (redirect the payment)", () => expectRevert(sim({...fresh, inputs: {...fresh.inputs, recipient: d.address(6)}}), "InvalidProof"));
    it("amount", () => expectRevert(sim({...fresh, inputs: {...fresh.inputs, publicAmount: USDC(2)}}), "InvalidProof"));
    it("fee", () => expectRevert(sim({...fresh, inputs: {...fresh.inputs, fee: USDC(0.02)}}), "InvalidProof"));
    it("fee recipient (steal the relayer fee)", () => expectRevert(sim({...fresh, ext: {...fresh.ext, feeRecipient: d.address(6)}}), "InvalidProof"));
    it("x402 request id (re-attach to another request)", () => expectRevert(sim({...fresh, ext: {...fresh.ext, requestId: `0x${"33".repeat(32)}`}}), "InvalidProof"));
    it("deadline", () => expectRevert(sim({...fresh, ext: {...fresh.ext, deadline: fresh.ext.deadline + 1n}}), "InvalidProof"));
    it("encrypted output", () => expectRevert(sim({...fresh, ext: {...fresh.ext, encryptedOutput0: "0x00"}}), "InvalidProof"));
    it("output commitment", () => expectRevert(sim({...fresh, inputs: {...fresh.inputs, outCommitments: [fresh.inputs.outCommitments[0] + 1n, fresh.inputs.outCommitments[1]]}}), "InvalidProof"));
    it("nullifier", () => expectRevert(sim({...fresh, inputs: {...fresh.inputs, nullifiers: [fresh.inputs.nullifiers[0] + 1n, fresh.inputs.nullifiers[1]]}}), "InvalidProof"));
    it("token", () => expectRevert(sim({...fresh, inputs: {...fresh.inputs, token: d.deployment.weth}}), "InvalidProof"));
    it("unknown root", () => expectRevert(sim({...fresh, inputs: {...fresh.inputs, root: 12345n}}), "UnknownRoot"));
    it("unknown association-set root", () => expectRevert(sim({...fresh, inputs: {...fresh.inputs, aspRoot: 12345n}}), "InvalidAssociationRoot"));
    it("non-canonical nullifier (x + FIELD)", () =>
      expectRevert(
        sim({...fresh, inputs: {...fresh.inputs, nullifiers: [fresh.inputs.nullifiers[0] + 21888242871839275222246405745257275088548364400416034343698204186575808495617n, fresh.inputs.nullifiers[1]]}}),
        "NotField",
      ));
    it("garbage proof", () => expectRevert(sim({...fresh, proof: `0x${"00".repeat(7232)}`}), "InvalidProof"));
    it("a different relayer front-running gets nothing: proof binds the fee recipient", async () => {
      // a front-runner can submit the same bundle, but the fee still goes to `relayer`
      const before = await erc20Balance(d, d.deployment.usdc, relayer);
      await submitBundle(d.wallet(6), d.publicClient, d.deployment.pool, fresh);
      expect(await erc20Balance(d, d.deployment.usdc, relayer)).toBe(before + USDC(0.01));
    });
  });

  describe("compliance: association set + ragequit", () => {
    it("excludes a blocklisted depositor; their private spends are impossible", async () => {
      await deposit(mallory, MALLORY, USDC(50));
      await publishAsp();
      await mallory.refresh();
      expect(mallory.balance(d.deployment.usdc)).toBe(USDC(50));
      await expect(mallory.preparePayment({token: d.deployment.usdc, amount: USDC(1), recipient: merchant})).rejects.toThrow(/not in the association set/);
    });

    it("but can ragequit: funds go back ONLY to the original depositor, publicly", async () => {
      const owned = mallory.valueNotes(d.deployment.usdc)[0]!;
      const rq = await mallory.prepareRagequit(owned);
      const before = await erc20Balance(d, d.deployment.usdc, d.address(MALLORY));
      // anyone may submit it (here: the relayer); the money still goes to the depositor
      await submitRagequit(d.wallet(RELAYER), d.publicClient, d.deployment.pool, rq);
      expect(await erc20Balance(d, d.deployment.usdc, d.address(MALLORY))).toBe(before + USDC(50));
      await mallory.refresh();
      expect(mallory.balance(d.deployment.usdc)).toBe(0n);
    });

    it("honest users keep working after the set changes", async () => {
      const b = await alice.preparePayment({token: d.deployment.usdc, amount: USDC(1), recipient: merchant});
      await submitBundle(d.wallet(RELAYER), d.publicClient, d.deployment.pool, b);
    });
  });

  it("wallet restored from the seed alone finds the same balance", async () => {
    const restored = walletFor(1);
    await restored.refresh();
    await alice.refresh();
    expect(restored.balance(d.deployment.usdc)).toBe(alice.balance(d.deployment.usdc));
  });
});
