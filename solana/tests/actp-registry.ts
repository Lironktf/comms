import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL} from "@solana/web3.js";
import {keccak256} from "js-sha3";
import {assert, expect} from "chai";
import {ActpRegistry} from "../target/types/actp_registry";

/**
 * Full integration suite for the ACTP Solana registry — mirrors the Solidity coverage:
 * registration + duplicate/invalid prevention, ownership transfer, lifecycle state machine
 * with terminal revocation + identifier quarantine, metadata versioning, verifier RBAC,
 * attestations (issue / non-verifier reject / type + expiry bounds / revoke / ban), and
 * vendor-signed metadata. Run with `anchor test` (spins a local validator).
 */

const SCHEME = Buffer.from("actp.vendor.v1");
const ZERO32 = new Array(32).fill(0);

function domainHash(d: string): Buffer {
  return Buffer.from(keccak256.arrayBuffer(Buffer.from(d)));
}
function vendorId(d: string): Buffer {
  return Buffer.from(keccak256.arrayBuffer(Buffer.concat([SCHEME, domainHash(d)])));
}
function bytes(b: Buffer): number[] {
  return Array.from(b);
}

describe("actp-registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ActpRegistry as Program<ActpRegistry>;
  const admin = provider.wallet as anchor.Wallet;
  const pid = program.programId;

  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], pid)[0];
  const vendorPda = (d: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("vendor"), vendorId(d)], pid)[0];
  const domainPda = (d: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("domain"), domainHash(d)], pid)[0];
  const walletPda = (w: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("wallet"), w.toBuffer()], pid)[0];
  const verifierPda = (a: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("verifier"), a.toBuffer()], pid)[0];
  const attPda = (d: string, t: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("att"), vendorId(d), Buffer.from([t])], pid)[0];
  const banPda = (a: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("ban"), a.toBuffer()], pid)[0];

  async function fund(kp: Keypair) {
    const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  }

  async function register(owner: Keypair | anchor.Wallet, d: string, opts: {metaHash?: Buffer} = {}) {
    await program.methods
      .registerVendor(
        bytes(vendorId(d)),
        bytes(domainHash(d)),
        d,
        "https://api." + d + "/x402",
        opts.metaHash ? bytes(opts.metaHash) : ZERO32,
        opts.metaHash ? "ipfs://meta" : "",
      )
      .accounts({
        config: configPda,
        vendor: vendorPda(d),
        domainClaim: domainPda(d),
        owner: (owner as any).publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers("payer" in owner ? [] : [owner as Keypair])
      .rpc();
  }

  it("initializes config with the deployer as admin/guardian/verifier_admin", async () => {
    await program.methods
      .initialize()
      .accounts({config: configPda, admin: admin.publicKey, systemProgram: SystemProgram.programId})
      .rpc();
    const c = await program.account.config.fetch(configPda);
    assert.ok(c.admin.equals(admin.publicKey));
    assert.ok(c.guardian.equals(admin.publicKey));
    assert.ok(c.verifierAdmin.equals(admin.publicKey));
    assert.equal(c.paused, false);
  });

  it("registers a vendor and stores its record", async () => {
    const d = "acme.example";
    await register(admin, d, {metaHash: domainHash("meta-v1")});
    const v = await program.account.vendor.fetch(vendorPda(d));
    assert.deepEqual(v.vendorId, bytes(vendorId(d)));
    assert.ok(v.owner.equals(admin.publicKey));
    assert.equal(v.primaryDomain, d);
    assert.equal(v.metadataVersion.toNumber(), 1);
    assert.equal(Object.keys(v.status)[0], "active");

    const claim = await program.account.domainClaim.fetch(domainPda(d));
    assert.deepEqual(claim.vendorId, bytes(vendorId(d)));
    const c = await program.account.config.fetch(configPda);
    assert.isAtLeast(c.vendorCount.toNumber(), 1);
  });

  it("prevents duplicate domain registration (claim PDA already exists)", async () => {
    const other = Keypair.generate();
    await fund(other);
    let threw = false;
    try {
      await register(other, "acme.example");
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "second registration of acme.example must fail");
  });

  it("rejects an invalid (non-normalized) domain", async () => {
    const d = "UPPER.example";
    let threw = false;
    try {
      await program.methods
        .registerVendor(bytes(vendorId(d)), bytes(domainHash(d)), d, "", ZERO32, "")
        .accounts({
          config: configPda,
          vendor: vendorPda(d),
          domainClaim: domainPda(d),
          owner: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/InvalidDomain|invalid or non-normalized/i);
    }
    assert.isTrue(threw);
  });

  it("adds and removes a domain, freeing it for reuse", async () => {
    const d = "acme.example";
    const extra = "shop.acme.example";
    await program.methods
      .addDomain(bytes(vendorId(d)), bytes(domainHash(extra)), extra)
      .accounts({
        config: configPda,
        vendor: vendorPda(d),
        domainClaim: domainPda(extra),
        owner: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    let claim = await program.account.domainClaim.fetch(domainPda(extra));
    assert.deepEqual(claim.vendorId, bytes(vendorId(d)));

    await program.methods
      .removeDomain(bytes(vendorId(d)), bytes(domainHash(extra)))
      .accounts({config: configPda, vendor: vendorPda(d), domainClaim: domainPda(extra), owner: admin.publicKey})
      .rpc();
    const closed = await program.account.domainClaim.fetchNullable(domainPda(extra));
    assert.isNull(closed, "removed domain claim should be closed");
  });

  it("cannot remove the primary domain", async () => {
    const d = "acme.example";
    let threw = false;
    try {
      await program.methods
        .removeDomain(bytes(vendorId(d)), bytes(domainHash(d)))
        .accounts({config: configPda, vendor: vendorPda(d), domainClaim: domainPda(d), owner: admin.publicKey})
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/CannotRemovePrimaryDomain|primary/i);
    }
    assert.isTrue(threw);
  });

  it("claims wallets uniquely across vendors", async () => {
    const d = "acme.example";
    const w = Keypair.generate().publicKey;
    await program.methods
      .addWallet(bytes(vendorId(d)), w)
      .accounts({
        config: configPda,
        vendor: vendorPda(d),
        walletClaim: walletPda(w),
        owner: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const claim = await program.account.walletClaim.fetch(walletPda(w));
    assert.ok(claim.wallet.equals(w));

    // a second vendor cannot claim the same wallet
    const d2 = "beta.example";
    await register(admin, d2);
    let threw = false;
    try {
      await program.methods
        .addWallet(bytes(vendorId(d2)), w)
        .accounts({
          config: configPda,
          vendor: vendorPda(d2),
          walletClaim: walletPda(w),
          owner: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "duplicate wallet claim must fail");
  });

  it("only the owner can edit the vendor", async () => {
    const d = "acme.example";
    const stranger = Keypair.generate();
    await fund(stranger);
    let threw = false;
    try {
      await program.methods
        .setX402Endpoint(bytes(vendorId(d)), "https://evil")
        .accounts({config: configPda, vendor: vendorPda(d), owner: stranger.publicKey})
        .signers([stranger])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/NotVendorOwner|not the vendor owner/i);
    }
    assert.isTrue(threw);
  });

  it("bumps metadata version on each anchor", async () => {
    const d = "acme.example";
    await program.methods
      .setMetadata(bytes(vendorId(d)), bytes(domainHash("meta-v2")), "ipfs://v2")
      .accounts({config: configPda, vendor: vendorPda(d), owner: admin.publicKey})
      .rpc();
    const v = await program.account.vendor.fetch(vendorPda(d));
    assert.equal(v.metadataVersion.toNumber(), 2);
  });

  it("does a two-step ownership transfer", async () => {
    const d = "beta.example";
    const next = Keypair.generate();
    await fund(next);
    await program.methods
      .transferOwnership(bytes(vendorId(d)), next.publicKey)
      .accounts({config: configPda, vendor: vendorPda(d), owner: admin.publicKey})
      .rpc();
    // unchanged until accepted
    let v = await program.account.vendor.fetch(vendorPda(d));
    assert.ok(v.owner.equals(admin.publicKey));

    await program.methods
      .acceptOwnership(bytes(vendorId(d)))
      .accounts({vendor: vendorPda(d), newOwner: next.publicKey})
      .signers([next])
      .rpc();
    v = await program.account.vendor.fetch(vendorPda(d));
    assert.ok(v.owner.equals(next.publicKey));
  });

  it("enforces the lifecycle state machine and quarantines revoked identifiers", async () => {
    const d = "gamma.example";
    await register(admin, d);

    // suspend then unsuspend (guardian = admin)
    await program.methods
      .suspend(bytes(vendorId(d)))
      .accounts({config: configPda, guardian: admin.publicKey, vendor: vendorPda(d)})
      .rpc();
    let v = await program.account.vendor.fetch(vendorPda(d));
    assert.equal(Object.keys(v.status)[0], "suspended");

    await program.methods
      .unsuspend(bytes(vendorId(d)))
      .accounts({config: configPda, guardian: admin.publicKey, vendor: vendorPda(d)})
      .rpc();

    // revoke (terminal)
    await program.methods
      .revoke(bytes(vendorId(d)))
      .accounts({config: configPda, vendor: vendorPda(d), signer: admin.publicKey})
      .rpc();
    v = await program.account.vendor.fetch(vendorPda(d));
    assert.equal(Object.keys(v.status)[0], "revoked");

    // revoked is terminal: suspend must now fail
    let threw = false;
    try {
      await program.methods
        .suspend(bytes(vendorId(d)))
        .accounts({config: configPda, guardian: admin.publicKey, vendor: vendorPda(d)})
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "revoked -> suspended must be rejected");

    // the domain claim was never closed -> re-registration is impossible
    let reReg = false;
    try {
      const owner2 = Keypair.generate();
      await fund(owner2);
      await register(owner2, d);
    } catch {
      reReg = true;
    }
    assert.isTrue(reReg, "revoked vendor's domain must stay quarantined");
  });

  it("guardian-only lifecycle: a stranger cannot suspend", async () => {
    const d = "acme.example";
    const stranger = Keypair.generate();
    await fund(stranger);
    let threw = false;
    try {
      await program.methods
        .suspend(bytes(vendorId(d)))
        .accounts({config: configPda, guardian: stranger.publicKey, vendor: vendorPda(d)})
        .signers([stranger])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(threw);
  });

  it("grants a verifier and accepts an attestation; rejects a non-verifier", async () => {
    const d = "acme.example";
    const verifier = Keypair.generate();
    await fund(verifier);

    await program.methods
      .grantVerifier(verifier.publicKey)
      .accounts({
        config: configPda,
        verifierAdmin: admin.publicKey,
        verifier: verifierPda(verifier.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const expires = new anchor.BN(Math.floor(Date.now() / 1000) + 180 * 86400);
    await program.methods
      .attest(bytes(vendorId(d)), 3, bytes(domainHash("kyb-report")), expires)
      .accounts({
        vendor: vendorPda(d),
        verifier: verifierPda(verifier.publicKey),
        attestation: attPda(d, 3),
        attester: verifier.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([verifier])
      .rpc();
    const a = await program.account.attestation.fetch(attPda(d, 3));
    assert.equal(a.attType, 3);
    assert.ok(a.attester.equals(verifier.publicKey));
    assert.equal(a.revoked, false);

    // a non-verifier has no verifier PDA -> attest fails
    const impostor = Keypair.generate();
    await fund(impostor);
    let threw = false;
    try {
      await program.methods
        .attest(bytes(vendorId(d)), 2, bytes(domainHash("x")), expires)
        .accounts({
          vendor: vendorPda(d),
          verifier: verifierPda(impostor.publicKey),
          attestation: attPda(d, 2),
          attester: impostor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([impostor])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "non-verifier attestation must fail");
  });

  it("rejects invalid attestation type and out-of-bounds expiry", async () => {
    const d = "acme.example";
    const verifier = Keypair.generate();
    await fund(verifier);
    await program.methods
      .grantVerifier(verifier.publicKey)
      .accounts({
        config: configPda,
        verifierAdmin: admin.publicKey,
        verifier: verifierPda(verifier.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const good = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
    // type 4 (VendorSigned) is reserved -> invalid for attest
    let threw = false;
    try {
      await program.methods
        .attest(bytes(vendorId(d)), 4, bytes(domainHash("x")), good)
        .accounts({
          vendor: vendorPda(d),
          verifier: verifierPda(verifier.publicKey),
          attestation: attPda(d, 4),
          attester: verifier.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([verifier])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/InvalidAttestationType/i);
    }
    assert.isTrue(threw);

    // expiry in the past -> invalid
    const past = new anchor.BN(Math.floor(Date.now() / 1000) - 10);
    let threw2 = false;
    try {
      await program.methods
        .attest(bytes(vendorId(d)), 2, bytes(domainHash("x")), past)
        .accounts({
          vendor: vendorPda(d),
          verifier: verifierPda(verifier.publicKey),
          attestation: attPda(d, 2),
          attester: verifier.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([verifier])
        .rpc();
    } catch (e: any) {
      threw2 = true;
      expect(e.toString()).to.match(/InvalidExpiry/i);
    }
    assert.isTrue(threw2);
  });

  it("lets the vendor owner sign its metadata (level 4) bound to the current hash", async () => {
    const d = "acme.example";
    await program.methods
      .vendorSignMetadata(bytes(vendorId(d)))
      .accounts({
        vendor: vendorPda(d),
        attestation: attPda(d, 4),
        owner: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const v = await program.account.vendor.fetch(vendorPda(d));
    const a = await program.account.attestation.fetch(attPda(d, 4));
    assert.equal(a.attType, 4);
    assert.deepEqual(a.evidenceHash, v.metadataHash);
    assert.ok(a.attester.equals(admin.publicKey));
  });

  it("revokes an attestation (by the verifier admin)", async () => {
    const d = "acme.example";
    await program.methods
      .revokeAttestation(bytes(vendorId(d)), 3)
      .accounts({config: configPda, attestation: attPda(d, 3), signer: admin.publicKey})
      .rpc();
    const a = await program.account.attestation.fetch(attPda(d, 3));
    assert.equal(a.revoked, true);
  });

  it("bans an attester with a cutoff", async () => {
    const attester = Keypair.generate();
    const cutoff = new anchor.BN(Math.floor(Date.now() / 1000));
    await program.methods
      .banAttester(attester.publicKey, cutoff)
      .accounts({
        config: configPda,
        verifierAdmin: admin.publicKey,
        ban: banPda(attester.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const b = await program.account.ban.fetch(banPda(attester.publicKey));
    assert.ok(b.attester.equals(attester.publicKey));
    assert.equal(b.cutoff.toString(), cutoff.toString());
  });

  it("pause blocks new registrations; unpause restores them", async () => {
    await program.methods.pause().accounts({config: configPda, admin: admin.publicKey}).rpc();
    let threw = false;
    try {
      await register(admin, "paused.example");
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/Paused|paused/i);
    }
    assert.isTrue(threw);

    await program.methods.unpause().accounts({config: configPda, admin: admin.publicKey}).rpc();
    await register(admin, "paused.example");
    const v = await program.account.vendor.fetch(vendorPda("paused.example"));
    assert.equal(Object.keys(v.status)[0], "active");
  });
});
