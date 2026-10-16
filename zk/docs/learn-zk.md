# Learning ZK through this codebase (M0 + exercises)

You know Solidity, Rust and TypeScript, so this maps each ZK idea onto code in this repo.
No black boxes: every claim points at the line that implements it.

## 1. What a circuit is

A Noir `main` is not a program that runs for the verifier. It is a **statement**: "there exist
private values making all these `assert`s true, for these public values." `nargo execute` finds
the private values' full assignment (the *witness*). `bb prove` produces a short proof that a
witness exists. `bb verify` (or the Solidity verifier) checks the proof using only the public
values. Nobody re-runs your code; they check a polynomial identity that only holds if every
constraint was satisfied.

Read `circuits/m0_commitment/src/main.nr`: public `commitment`, private `amount, secret`, one
assert. The verifier learns the statement is true and nothing else.

**The golden rule: anything not constrained is not proven.** If `main` computed a value and
never asserted on it, a cheating prover can set it to anything. Only Noir's constrained code
produces constraints. `unconstrained fn` (Brillig) results are hints and must be checked by
asserts. `circuits/lib/src/lib.nr::merkle_root` uses `index.to_le_bits()`, which is constrained,
so the index really is < 2^20. Try exercise 4 to see what would happen otherwise.

## 2. The three things a spend proves

From `circuits/transact/src/main.nr`:

1. **Ownership.** `owner = H3(OWNER, sk, 0)` is recomputed from the private `sk` inside every
   input commitment. Anyone can compute a Merkle path to any leaf, so membership alone proves
   nothing. Knowing the `sk` that opens the commitment is what makes the money yours.
2. **Existence.** `merkle_root(commitment, index, path) == root`, where `root` is one the
   contract has actually produced.
3. **Uniqueness.** `nullifier = H3(NULL, nk, H2(commitment, index))` is published. It is
   deterministic per note (so a second spend publishes the same nullifier and the contract
   rejects it), but it can't be linked to the commitment without `nk`.

Plus **value conservation** (`in0 + in1 == out0 + out1 + publicAmount + fee`) with every amount
range-checked as `u128`. Without range checks, `-1` in the field is `p − 1`, a huge positive
number, and a prover could mint money ("field wraparound").

## 3. Why public inputs bind things

The verifier checks the proof against the exact public-input vector the contract passes. Change
one field element (the recipient, say) and verification fails.

`recipient` and `context` aren't used in any constraint, but they are still bound. See
`contracts/test/Verifiers.t.sol`, which flips each public input of a real proof and requires a
rejection. Some proof systems (Groth16 in circom) need a dummy constraint (`x*x`) to bind unused
public inputs; UltraHonk binds them through its public-input argument, and the test proves it for
our verifiers.

## 4. Proving systems in one paragraph

Noir compiles to ACIR, and Barretenberg turns that into UltraHonk, a PLONK-family proof system
with custom gates. One of those gates is a native Poseidon2 gate, which is why our hashes are
cheap in-circuit (transact: 9,378 gates). Proofs are ~8 KB.

`-t evm` makes the Fiat-Shamir transcript use keccak, which is cheap for the EVM, and enables
zero-knowledge masking. Without ZK (`evm-no-zk`) a proof can leak information about the witness,
which would defeat the purpose of a privacy pool.

The setup uses a universal SRS (no per-circuit trusted ceremony like Groth16's).

## Exercises (run them yourself)

Setup: the toolchain in deploy.md §0, then `export PATH="$HOME/.bb:$HOME/.nargo/bin:$HOME/.foundry/bin:$PATH"`.

### Ex 1: execute and test
```bash
cd zk/circuits
nargo test --workspace                       # all circuit unit tests, incl. should_fail ones
nargo execute --package m0_commitment        # uses m0_commitment/Prover.toml
```
Now change `amount` in `m0_commitment/Prover.toml` to 43 and run `nargo execute` again. It fails:
you cannot even *produce a witness* for a false statement.

### Ex 2: prove and verify natively with bb
```bash
nargo compile --package m0_commitment && nargo execute --package m0_commitment
bb write_vk -b target/m0_commitment.json -o target/m0_commitment -t evm
bb prove -b target/m0_commitment.json -w target/m0_commitment.gz -o target/m0_commitment/proof_out -t evm -k target/m0_commitment/vk
bb verify -p target/m0_commitment/proof_out/proof -i target/m0_commitment/proof_out/public_inputs -k target/m0_commitment/vk -t evm
xxd -p target/m0_commitment/proof_out/public_inputs    # the ONLY thing the verifier learns
```

### Ex 3: verify on-chain (anvil)
```bash
anvil &
cd ../contracts && forge build
forge create src/verifiers/M0CommitmentVerifier.sol:M0CommitmentVerifier --broadcast \
  --rpc-url http://127.0.0.1:8545 --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
V=<deployed address>
P=0x$(xxd -p ../circuits/target/m0_commitment/proof_out/proof | tr -d '\n')
PI=0x$(xxd -p ../circuits/target/m0_commitment/proof_out/public_inputs | tr -d '\n')
cast call $V "verify(bytes,bytes32[])(bool)" $P "[$PI]"                                  # true
cast call $V "verify(bytes,bytes32[])(bool)" $P "[0x$(printf '%064x' 1)]"                # reverts
cast estimate $V "verify(bytes,bytes32[])" $P "[$PI]"                                   # ~600k gas
```

### Ex 4: break a circuit, watch a test catch it
In `circuits/lib/src/lib.nr::merkle_root`, the index bits come from `index.to_le_bits()`.
Replace the decomposition with something unconstrained (e.g. compute bits in an
`unconstrained fn` and don't check they recompose to `index`). Run
`nargo test --package shielded`: `merkle_index_out_of_range_fails` should now fail, because the
prover could alias index 8 in a depth-3 tree. Revert your change.

### Ex 5: Merkle membership
`m0_merkle/Prover.toml` proves leaf 333 at index 2 of the tree `[111, 222, 333, 444]`.
- Change `index` to 3 and the proof fails: the path no longer recomputes the root.
- Regenerate the file with `npx tsx zk/client/scripts/m0-inputs.ts`.

### Ex 6: the real thing
```bash
npm run test -w zk/client                                    # unit tests (hashes)
cd zk/client && npx vitest run --config vitest.e2e.config.ts test/pool.e2e.test.ts
```
Read `test/pool.e2e.test.ts` top to bottom. Every tampering test is a "negative proof test":
the proof is real, one public field changes, and the chain rejects it.

## Prior art these designs come from

| idea here | origin |
|---|---|
| notes, nullifiers, nk/owner split, faerie-gold fix (leaf index in nullifier) | Zcash Sapling/Orchard |
| 2-in-2-out with arbitrary amounts, relayer fee in the proof, ext-data hash binding | Tornado Cash Nova |
| labels, association sets, ragequit to original depositor | Privacy Pools (0xbow) |
| unshield → swap → reshield through an adapter in one tx | Railgun relay adapter |
| private x402 | zx402 (Cardano demo); ours runs on Base with x402 v2 packages |
