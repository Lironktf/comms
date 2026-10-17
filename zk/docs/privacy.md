# Privacy properties (honest version)

## What an observer of the chain sees

| event | public | hidden |
|---|---|---|
| deposit | depositor address, token, amount, time, the deposit's label | owner key, blinding, policy |
| pay a merchant | "the pool paid M amount X of token T at time t", fee, relayer, x402 request id | which deposit/user/agent paid, their balance, history, other merchants |
| private transfer | "some spend happened" (2 nullifiers, 2 commitments, ciphertexts) | sender, recipient, amount |
| swap | "the pool swapped X of A for Y of B" | who |
| Path B payment | "the pool authorized a transfer of X to M" and later USDC moved pool → M | who |
| refundable / escrow payment | as a payment, **plus** the mode and terms (escrow windows, arbiter address), and later each refund amount, release, claim, dispute or expiry, all tied to the payment id | who paid, and who receives the refund note. A refund is just a new note in the tree; spending it later doesn't link back |
| ragequit | **everything** (deposit label, amount, depositor gets paid): it's the public exit | n/a |
| policy payment | same as a payment, **plus the fact that the payer is policy-bound** (it calls `payWithPolicy`, carries a vendor-tree root and a timestamp) | the policy itself, caps, budget, remaining budget, which agent/owner. One policy bit IS public: `vendorChecked` (does this policy require Grayr-verified merchants?) |

**The merchant's revenue is public.** That is the trade-off for "merchants need no setup": they
receive ordinary USDC. Hidden merchant revenue (shielded receiving) is in future-research.md.

## Who learns what

- **Relayer / facilitator:** "someone pays M $X" (public anyway), and the IP address the bundle
  came from. Never the payer's identity, notes or balance.
- **Merchant:** the same, plus whatever the HTTP request reveals (IP, headers, cookies).
- **The ASP:** deposits (public anyway). It never learns spends.
- **A private-transfer recipient** learns the deposit label of the note they receive, because they
  need it to spend. Labels map publicly to depositor addresses, so **the recipient of a private
  transfer can see which deposit funded it.** Outside observers can't.
  - This is inherent to label-based association sets (Privacy Pools has the same property, and
    sidesteps it by having no internal transfers).
  - Merchant payments don't have this problem, since the merchant receives public USDC, not a note.

## Remaining leaks and mitigations

| leak | mitigation |
|---|---|
| timing (deposit → immediate same-size payment) | wait; deposit round amounts; batching relayers mix several payments into one tx |
| amount correlation (deposit 37.12, withdraw 37.12) | deposit round amounts; standard merchant prices help (everyone pays $0.25) |
| IP address of the agent | send bundles via Tor/a proxy; relayer and merchant are different parties |
| behavioral patterns (same merchant every 5 min) | inherent; batching and many users blur it |
| anonymity set size | grows with users; a fresh pool on testnet has almost none, so don't overclaim |
| "one deposit, many spends": all spends descend from one label | the label is never revealed by private spends (proven in ZK); only ragequit reveals it |
| gas payer | never the user: the relayer submits. A user submitting from their own address would deanonymize themselves |
| ciphertext metadata | fixed sizes per note type (181 B value note, 137 B budget note), so sizes leak the note TYPE only, which the entry point already reveals |
| escrow release/dispute transactions | the payer acts with secrets, never a key. Submit them from a relayer or a fresh address: sending them from an address linked to you links you to the payment |
| refund timing | a refund note appears when the merchant refunds; spending it right after re-creates a timing link. Wait, as with deposits |
| payment modes split the anonymity set | refundable and escrow payments are distinguishable from direct ones (different entry point / event); payers who use the same mode hide among each other |
| policy payments form their own anonymity set | they are distinguishable from plain payments by the entry point; the set is "all policy-bound agents", not all users |

## What the proof does NOT hide

Public inputs are public, so the token, the amounts that leave the pool, the recipient, the fee,
the relayer, and (for policy payments) the vendor-tree root and an approximate timestamp are all
visible. The bb proofs use the **ZK** variant (`-t evm`, not `evm-no-zk`), so the proof bytes
themselves reveal nothing about the witness.
