# ACTP — Integration & Outreach Candidates

**What this is.** Every company surfaced across the agentic-commerce research, in one table. ACTP is a neutral, cross-rail **pre-payment decision layer** — merchant trust + spending policy + enforcement — that sits *above* payment rails and agent infrastructure. An agent (or the rail/wallet/tool-router it uses) asks ACTP *"should this agent pay THIS merchant, THIS amount, right now?"* and gets an ALLOW / DENY / REQUIRE_APPROVAL verdict plus a signed enforcement token, before any payment settles.

**The one-sentence thesis that holds across all ~90 companies below.** Everyone that holds agent funds, authorizes agent spend, or moves the money enforces *how much / to which address / is the agent real* — session keys, spend caps, MCC controls, KYT/sanctions on the wallet, agent identity. **None neutrally decides "should this agent pay this specific merchant, across rails."** The open specs say so out loud: x402 explicitly excludes merchant trust; Google AP2 verifies user→agent consent, not the merchant; Thirdweb calls its own spend mandate "identity-agnostic." That empty seat is ACTP's wedge, and it's why each row has a concrete reason to adopt.

**Legend** — 🤝 Partner (integrate above, clean fit) · ⚔️ Co-opetition (integrate, but watch for drift into our lane) · 🥊 Competitor (staking the same claim) · 📐 Standard (align with, don't sell to) · 👀 Watch/Skip (adjacent or not yet transacting).

> Contact channels for outreach are public only (LinkedIn / X / GitHub / docs). No personal emails or phone numbers were collected or invented. Fields that couldn't be confirmed from a public source are marked *unverified* rather than guessed. Recent M&A / leadership changes are flagged inline.

---

## 1 · Payment rails, facilitators & settlement

| # | Company | Website | CEO / Founder | What they do | How they need ACTP |
|--|--|--|--|--|--|
| 1 | **Coinbase x402** ⚔️ | coinbase.com · docs.cdp.coinbase.com/x402 | Brian Armstrong (Coinbase CEO); Erik Reppel (x402 author, Head of Eng, CDP) | HTTP-native stablecoin payment protocol for APIs/agents; now under the x402 Foundation | Spec *explicitly excludes* merchant trust, reputation & spend policy — ACTP is the client-side check above the facilitator (**proven live in our demo**) |
| 2 | **Stripe** 🤝 | stripe.com | Patrick Collison (Co-founder & CEO) | Payments infra; Issuing (virtual/physical cards) + Agentic Commerce Protocol (with OpenAI) | Answers the `issuing_authorization.request` webhook & the ACP checkout; SPTs scope amount+merchant but never verify merchant legitimacy cross-rail |
| 3 | **Daimo Pay** 🤝 | daimo.com · pay.daimo.com | DC Posch & Nalin Bhardwaj (co-founders) | Stablecoin deposit/checkout — pay from any wallet/chain/token, receive chosen stablecoin | Pure rail, zero buyer-side trust/budget logic; ACTP is the approve/deny its checkout executes against |
| 4 | **Nevermined** 🤝 | nevermined.ai | Don Gossen (Founder & CEO) | Multi-rail agent payment/metering (Stripe, x402, MCP, Visa IC) | No merchant-trust function anywhere in the stack; clean neutral layer to sit above |
| 5 | **Radius** 🤝 | radiustech.xyz | Robert Bench (Co-founder & CEO, ex-Circle/USDC) | Sub-second EVM settlement engine for M2M / agent stablecoin payments | Settlement only, no policy/trust layer — ACTP decides before it settles; founder credibility is a bonus |
| 6 | **Sphere** 🤝 | spherepay.co | Arnold Lee (Co-founder & CEO) | Stablecoin cross-border payments API + SphereNet ledger | Moves money across borders with no pre-pay merchant/policy gate — that's ACTP |
| 7 | **Loop Crypto** 🤝 | loopcrypto.xyz | Eleni Steinman (Co-founder & CEO) *(LinkedIn hints acquisition — verify)* | On-chain recurring/subscription "autopay" — authorize once, charge each period | A wallet authorized once then charged repeatedly is exactly the case that needs a per-charge merchant/budget check |
| 8 | **Request Network** 🤝 | request.network · request.finance | Christophe Lassuyt (Co-founder & CEO, Request Finance) | On-chain invoicing / immutable payment requests | No counterparty-trust scoring; ACTP scores the payee before the request is paid |
| 9 | **Superfluid** 🤝 | superfluid.finance | Francesco Renzi (Co-founder & CEO) | Continuous real-time "streaming" token payments on-chain | No notion of whether the stream recipient is a trustworthy merchant; ACTP gates stream creation |
| 10 | **PayAI** 🤝 | payai.network | *unverified (anonymous team)* | Solana-first x402 facilitator for agent micropayments, no accounts/keys | Same x402 carve-out (no trust/policy) on Solana; ACTP inserts client-side. *Verify the team before outreach* |
| 11 | **PayPal Agentic Commerce** 🤝 | paypal.com | Alex Chriss (President & CEO) | "Agent Ready" payments + catalog/order mgmt for AI-driven shopping | Rail-locked; outsources agent identity and has no neutral cross-rail merchant decision |
| 12 | **Circle (Agent Stack)** ⚔️ | circle.com | Jeremy Allaire (Co-founder & CEO) | USDC issuer; Agent Wallets + USDC nanopayments + a curated Agent Marketplace | Marketplace drifts toward merchant-vetting but is single-rail (USDC); ACTP is neutral and cross-rail |

## 2 · Agent wallets, smart accounts & key management

| # | Company | Website | CEO / Founder | What they do | How they need ACTP |
|--|--|--|--|--|--|
| 13 | **Openfort** 🤝 | openfort.io | Joan & Jaume Alavedra (co-founders) | Embedded wallets + off-chain policy engine for apps/agents | Policy engine runs before signing and proves *agent* authority via VCs, but explicitly does NOT verify the merchant — ACTP is that check |
| 14 | **Thirdweb** 🤝 | thirdweb.com | Furqan Rydhan (co-founder) | Full-stack web3 dev platform; server wallets, session keys | Pre-broadcast hook in Engine; publicly called its spend mandate "identity-agnostic" — a direct confirmation of ACTP's gap |
| 15 | **Portal** 🤝 | portalhq.io | Raj Parekh (Co-founder & CEO) | Embedded MPC wallets; synchronous signing-approval webhook | Webhook is deny-by-default and delegates merchant verification to an external caller = ACTP |
| 16 | **Safe** 🤝 | safe.global | Lukas Schor (President, Safe Foundation) — no single CEO | Dominant smart-account / multisig protocol (~$100B) | A Guard on every tx can revert; its "agent with a spending limit" enforces amount only, never merchant trust |
| 17 | **Pimlico** 🤝 | pimlico.io | Kristof Gazso (Founder, ERC-4337 co-author) | Account-abstraction infra: bundler, paymaster, SDK | Pure plumbing, no policy layer — ACTP is the decision before a sponsored UserOp |
| 18 | **ZeroDev** 🤝 | zerodev.app | Derek Chiang (Founder & CEO) *(acq. Offchain Labs 2025)* | ERC-4337 smart-account SDK, gasless/walletless | Ideal policy-module hook for the ACTP verdict (weight reduced post-acquisition) |
| 19 | **Sequence** 🤝 | sequence.xyz | Peter Kieltyka (Co-founder & CEO) | Web3 wallet + gaming infra, session keys | Session-key primitives but no agent-trust product; ACTP supplies the merchant/policy decision |
| 20 | **Web3Auth** 🤝 | web3auth.io | Zhen Yu Yong (Co-founder & CEO) *(acq. Consensys 2025)* | Non-custodial key mgmt / embedded-wallet auth | MPC signing feeds MetaMask's ERC-7710/x402 pipeline, which has no merchant-trust layer |
| 21 | **Dfns** 🤝 | dfns.co | Clarisse Hagège & Christopher Grilhault (co-CEOs) | Wallet-as-a-service / MPC custody for institutions | Its RequestApproval webhook is a clean external-decision slot for ACTP |
| 22 | **Fordefi** 🤝 | fordefi.com | Josh Schwartz (Co-founder & CEO) *(Paxos subsidiary)* | Institutional MPC wallet + DeFi security | Automated-verifier quorum slot to plug the ACTP verdict into before signing |
| 23 | **Turnkey** 🤝 | turnkey.com | Bryce Ferguson (Co-founder & CEO) | Programmable key mgmt / embedded wallets + policy engine | Policy enforces who / how-much on signing, not merchant trust — ACTP is the complementary layer |
| 24 | **Privy** 🤝 | privy.io | Henri Stern (Co-founder & CEO) *(acq. Stripe 2025)* | Embedded wallets & onboarding | Now inside Stripe; the pre-pay merchant decision complements its wallets + Stripe's rails |
| 25 | **Dynamic** 🤝 | dynamic.xyz | Itai Turbahn (Co-founder & CEO) *(reportedly acq. Fireblocks)* | Wallet/identity orchestration | Adds the cross-rail merchant decision its auth/wallet layer lacks |
| 26 | **Crossmint** 🤝 | crossmint.com | Rodri Fernández Touza (co-founder/CEO) | Wallet / stablecoin / tokenized-asset infra for 40k+ cos; agent commerce | Broad agent-commerce surface with no neutral merchant-trust decision |
| 27 | **Basis Theory** 🤝 | basistheory.com | Colin Luce (Co-founder & CEO) | Programmable card tokenization / PCI vault | ACTP is the policy decision before an agent uses the vaulted card |
| 28 | **Para** 🤝 | getpara.com | Nitya Subramanian (Founder & CEO) | Embedded wallets + auth ("who is authorized to transact"), ex-Capsule | Stops at the wallet layer / single-rail; ACTP adds merchant trust + cross-rail scope |

## 3 · Card issuing, banking-as-a-service & corporate spend

| # | Company | Website | CEO / Founder | What they do | How they need ACTP |
|--|--|--|--|--|--|
| 29 | **Lithic** 🤝 | lithic.com | Bo Jiang (Co-founder & CEO) | Modular card-issuing / processing API; dedicated agentic-commerce product | Auth Stream Access posts every txn for a real-time approve/decline — the cleanest neutral decision webhook; ACTP answers it |
| 30 | **Fireblocks** 🤝 | fireblocks.com | Michael Shaulov (Co-founder & CEO) | Digital-asset custody + Agentic Payments Suite (facilitator, agent wallets) | Its pre-settlement "validate/compliance" step is KYT/Travel Rule (wallet risk), not merchant identity — ACTP feeds that step |
| 31 | **Galileo** 🤝 | galileo-ft.com | Bill Kennedy (Interim CEO) *(SoFi-owned)* | Card issuing / processing / account infra | Authorization Controller API webhook carries a full merchant object — ideal for external trust scoring |
| 32 | **Unit** 🤝 | unit.co | Itai Damti (Co-founder & CEO) | Banking-as-a-service / embedded finance | JIT authorization webhook carries *no* merchant data — the starkest proof of the gap ACTP fills |
| 33 | **Marqeta** ⚔️ | marqeta.com | Mike Milotich (CEO, since Sep 2025) | Modern card-issuing platform; MCP server + Real-Time Decisioning | On Visa rails and building its own decisioning — can *consume* ACTP as an input but overlaps the policy narrative |
| 34 | **Ramp** ⚔️ | ramp.com | Eric Glyman & Karim Atiyeh (co-CEOs) | Corporate card + spend management; agent cards | Card-rail-only spend controls; can consume the ACTP verdict rather than build cross-rail merchant trust |
| 35 | **Highnote** ⚔️ | highnote.com | John MacIlwaine (Co-founder & CEO) | Card issuing / embedded finance; agentic commerce (Visa) | Visa-locked; overlaps spend policy, can consume ACTP as a decision input |
| 36 | **Brex** ⚔️ | brex.com | Pedro Franceschi (Co-founder & CEO) *(acq. Capital One, $5.15B)* | AI-native corporate card + spend mgmt; agent platform | Real-time policy on Visa; consume-as-input, not a neutral cross-rail merchant arbiter |
| 37 | **Alchemy** ⚔️ | alchemy.com | Nikil Viswanathan (Co-founder & CEO) | Web3 dev infra; AgentKit / AgentPay (cross-rail routing) + AgentCard | Racing to own agent-payment routing — ACTP fits above, but guard the neutral positioning |

## 4 · MCP tool-routers, integration infra & LLM gateways

| # | Company | Website | CEO / Founder | What they do | How they need ACTP |
|--|--|--|--|--|--|
| 38 | **Composio** 🤝 *(top pick)* | composio.dev | Soham Ganatra (Co-founder & CEO) | Connects agents to business software via one Tool Router (incl. Stripe/Brex/Coupa) | Owns the payment-tool distribution surface with *no* merchant/spend gate; one pre-execution hook fans out across every agent |
| 39 | **Arcade.dev** 🤝 | arcade.dev | Alex Salazar (Co-founder & CEO) | Enterprise MCP runtime; per-action authorized tool access + audit | Already denies tool calls at runtime for auth/scope — ACTP completes the enforcement path for merchant-trust/budget |
| 40 | **ACI.dev** 🤝 | aci.dev | *unverified* | OSS tool-calling platform; 600+ tools via unified MCP server + "instruction filters" | Already ships pre-execution guardrails; ACTP hardens NL heuristics into a signed, auditable payment decision |
| 41 | **Smithery** 🤝 | smithery.ai | Henry Mao (Co-founder & CEO) | MCP registry + hosted remote endpoints, pushing paid/monetized tools | Hosting paid third-party tools (incl. x402) creates the exact liability with no merchant gate — urgency |
| 42 | **Glama** 🤝 | glama.ai | Frank Fiegel (Founder) | MCP registry + inspector + gateway with per-tool access control | Add ACTP as a payment-time policy rule at the gateway |
| 43 | **Gram (Speakeasy)** 🤝 | speakeasy.com | Sagar Batchu (Co-founder & CEO) | Turns any API into a hosted OAuth MCP server | Natural place to inject a pre-pay policy tool into every generated server |
| 44 | **mcp.run (Dylibso)** 🤝 | mcp.run · dylibso.com | Steve Manuel (Co-founder & CEO) | Hosting/registry + runtime for MCP "servlets" | Enterprise buyers of the runtime want provable spend controls it doesn't offer |
| 45 | **Paragon** 🤝 | useparagon.com | Brandon Foo (Co-founder & CEO) | Embedded integration platform (embedded iPaaS) for B2B SaaS | Clean auth/execution embed to inject a pre-pay check |
| 46 | **Nango** 🤝 | nango.dev | Robin Guldener (Co-founder & CEO) | Unified API / OAuth / sync across 400+ APIs | ACTP is the payment decision it doesn't do (watch for x402 drift) |
| 47 | **Toolhouse** 🤝 | toolhouse.ai | Daniele Bernardi (Co-founder & CEO) | Agentic backend-as-a-service; curated tool library | Fronts Stripe/Shopify/QuickBooks tools with no pre-pay gate |
| 48 | **Lunar.dev** 🤝 | lunar.dev | Eyal Solomon (Co-founder & CEO) | Enterprise MCP gateway / AI control plane (MCPX) | ACTP is the payment-policy node in its control plane |
| 49 | **MintMCP** 🤝 | mintmcp.com | Jiquan Ngiam (Co-founder & CEO) | Enterprise MCP gateway + agent governance (SOC2/RBAC/audit) | ACTP is the spend decision inside that governance layer |
| 50 | **Apify** 🤝 | apify.com | Jan Čurn (Co-founder & CEO) | Marketplace of "Actors" for scraping/automation — paid data infra | Gate the paid Actor call agents make with an ACTP decision |
| 51 | **LiteLLM (BerriAI)** ⚔️ | litellm.ai | Krrish Dholakia (Co-founder & CEO) | OSS LLM gateway/proxy, unified interface to 100+ providers | Meters usage but doesn't decide merchant trust; ACTP for paid tool/endpoint calls beyond LLMs |
| 52 | **Dust** 🤝 | dust.tt | Gabriel Hubert (Co-founder & CEO) | Enterprise agent OS with an explicit governance roadmap | ACTP is the spend-policy decision inside its governance layer (OEM motion) |
| 53 | **One (ex-Pica)** 🤝 | withone.ai | Moe Katib (Founder & CEO) | Managed agent access to tens of thousands of tools (incl. Stripe/Shopify) | Brands itself "trust layer for AI agents" but has no payment-trust piece — ACTP reinforces its own positioning |
| 54 | **OpenRouter** ⚔️ | openrouter.ai | Alex Atallah (Co-founder & CEO) | Unified API gateway to hundreds of LLMs, consolidated billing | Billing gateway with no merchant/policy decision — adjacent, not overlapping |
| 55 | **Portkey** ⚔️ | portkey.ai | Rohit Agarwal (Founder & CEO) *(acq. Palo Alto Networks)* | AI gateway / control plane: routing, governance, cost | Governance is model-request-centric, not merchant-trust |
| 56 | **Requesty** ⚔️ | requesty.ai | Leslie Nooteboom (Co-founder & CEO) | LLM routing gateway across 400+ models | Adjacent LLM-routing, not a merchant-trust decision |
| 57 | **Helicone** 🤝 | helicone.ai | Justin Torre (Co-founder & CEO) *(acq. Mintlify 2026)* | OSS LLM observability + AI gateway | A logging/observability surface, not a payment decision — complementary |

## 5 · Agent frameworks & platforms

| # | Company | Website | Leader | What they do | How they need ACTP |
|--|--|--|--|--|--|
| 58 | **Microsoft Agent Framework** 🤝 | learn.microsoft.com/agent-framework | Microsoft (no single public lead) | OSS SDK/runtime unifying Semantic Kernel + AutoGen; MCP support | `DelegatingChatClient` middleware seam; MAF's own HITL docs use `process_payment` as the canonical *human* gate — ACTP makes it a programmatic signed decision; no rail = neutrality sells |
| 59 | **OpenAI Agents SDK / AgentKit** 🤝 | openai.com/index/introducing-agentkit | OpenAI | Toolset + SDK to build/deploy agents | Input tool-guardrail before the payment tool; guardrails do safety/human-approval, no merchant-trust engine. *Co-authors ACP → position above ACP, never as a rail* |
| 60 | **Lindy** 🤝 | lindy.ai | Flo Crivello (Founder & CEO) | No-code agents automating workflows across 1,600+ apps; Computer Use | Agents check out on real sites with zero enforcement — ACTP lets Lindy tell customers "your agent can't pay a fraudulent or unapproved merchant" |
| 61 | **/dev/agents** 👀 | *unverified* | David Singleton (Co-founder & CEO) | Cloud "OS" for AI agents ($56M seed, ~$500M val) | Strong future insertion point but not transacting yet — watch |

## 6 · Commerce & shopping agents

| # | Company | Website | CEO / Founder | What they do | How they need ACTP |
|--|--|--|--|--|--|
| 62 | **Rye** 🤝 *(+ amplifier)* | rye.com | Arjun Bhargava (Co-founder & CEO; w/ Justin Kan) | Universal Checkout API — agents buy across merchants | Frames "trust" as execution reliability, not merchant-vetting/budget; ACTP is the policy call its checkout executes — and they publish the landscape map (amplifier) |
| 63 | **Channel3** 🚫 *(excluded from outreach)* | trychannel3.com | Alexander Schiff (Co-founder & CEO) | Universal product graph + shopping API for agents (discovery layer; cart/checkout "coming soon") | Upstream discovery, complementary in principle and does none of our trust/policy functions — but excluded from outreach by founder call: positioning feels too close for comfort |
| 64 | **Firmly.ai** 🤝 | firmly.ai | Kumar Senthil (Co-founder & CEO) | Agentic-commerce checkout unifying ACP/UCP/AP2/MCP | ACTP is the pre-pay decision inside their unified checkout — one call regardless of protocol |
| 65 | **Perplexity (Buy with Pro)** 🤝 | perplexity.ai | Aravind Srinivas (Co-founder & CEO) | In-answer agentic checkout, PayPal one-click | Optimizes merchant-friendliness, not protecting the user's spend or vetting long-tail merchants; ACTP at cart assembly (harder embed — closed product) |
| 66 | **PayOS** 🤝 | payos.ai | Johnathan McGowan (Co-founder & CEO) | Agent-card abstraction so existing cards work for agent txns (Visa/MC pilot) | Card abstraction with no neutral cross-rail merchant/policy decision on top |
| 67 | **Prava** 🤝 | prava.space | Sushant Pandey (Co-founder & CEO) | Payments orchestrator/wallet + "Know Your Agent" identity | Agent-identity-centric; ACTP adds the merchant-trust + cross-rail policy dimension |

## 7 · Crypto autonomous-agent networks

| # | Project | Website | Lead | What they do | How they need ACTP |
|--|--|--|--|--|--|
| 68 | **ElizaOS** 🤝 *(best crypto fit)* | elizaos.ai | Shaw Walters (Founder, Eliza Labs) | OSS agentic framework, 50k+ agents, x402 support | Documented prompt-injection *drains* = proof there's no pre-payment gate; ACTP is a plugin/evaluator before `sendTransaction` |
| 69 | **Wayfinder** 🤝 | wayfinder.ai | *unverified (Parallel Studios)* | Omnichain agent protocol; agents act across chains via "Paths" | Path validation checks route correctness, not destination trustworthiness — clean pre-pay insertion |
| 70 | **Questflow** ⚔️ | questflow.ai | Bob Xu (Co-founder & CEO) | Multi-agent orchestration; runs its own x402 facilitator | Wants "human oversight for critical decisions" but has no neutral counterparty-trust gate; 30+ third-party agents to score — engage early |
| 71 | **Fetch.ai / ASI** ⚔️ | fetch.ai · superintelligence.io | Humayun Sheikh (Fetch CEO); Ben Goertzel (ASI CEO) | Agent platform (FET); merged AGI alliance | Settlement + self-referential reputation; spans crypto + Visa rails — overlaps but not neutral |
| 72 | **Olas (Autonolas)** ⚔️ | olas.network | DAO (core: Valory, David Minarsch CEO) | Protocol/stack for co-owned on-chain agents | Internal "Karma" reputation, Gnosis-only — not neutral or cross-rail |
| 73 | **Virtuals Protocol** ⚔️ | virtuals.io | Jansen Teng (Co-founder & CEO) | Tokenized co-owned agents; Agent Commerce Protocol (ACP) | ACP has only a *post-delivery* Evaluator — ACTP fits between negotiation and escrow funding (pre-pay gate) |
| 74 | **Theoriq** ⚔️ | theoriq.ai | Ron Bodkin (Co-founder & CEO) | Infra for coordinating agent "swarms" (DeFi) | Self-referential reputation; not a neutral cross-rail merchant decision |

## 8 · Agent identity, verification & trust

| # | Company | Website | CEO / Founder | What they do | How they relate to ACTP |
|--|--|--|--|--|--|
| 75 | **Vouched** ⚔️ | vouched.id | Peter Horadan (CEO) | Identity verification; "Know Your Agent" (AgentShield, KnowThat.ai directory) | Agent-authenticity-centric, leaves merchant-trust open; consume its agent signals as an ACTP input |
| 76 | **Billions** 🤝 | billions.network | Evin McMullen (Co-founder & CEO) | Identity/uniqueness + KYC for humans and agents | A verification input ACTP consumes; ACTP adds the merchant-side decision |
| 77 | **Concordium** 🤝 | concordium.com | Boris Bohrer-Bilowitzki (CEO) | L1 with protocol-level ZK identity, positioning for agentic economy | Complementary trust primitive, not a payment decision |
| 78 | **SafetyKit** 🤝 | safetykit.com | David Graunke (Co-founder & CEO) | AI agents automating fraud/risk/compliance investigations | Merchant-side risk engine that can feed ACTP risk signals (data-source partner) |
| 79 | **Prove** ⚔️ | prove.com | Rodger Desai (Founder & CEO) | Phone-centric identity; "Prove Verified Agent" | Agent-authenticity-centric distribution threat, not a neutral cross-rail merchant arbiter |
| 80 | **Trulioo** ⚔️ | trulioo.com | Vicky Bindra (CEO) | Global KYC/KYB; "Digital Agent Passport" (w/ Worldpay) | Reach threat via a major acquirer; consume its KYB signals, differentiate on neutral per-purchase merchant decision |

## 9 · Direct competitors — same "agent-trust control plane" claim

| # | Company | Website | CEO / Founder | What they do | How we differentiate |
|--|--|--|--|--|--|
| 81 | **Catena Labs (ACK)** 🥊 *(most-funded)* | catena.com | Sean Neville (Co-founder, ex-Circle/USDC) | "Trust infra for agentic commerce"; Agent Commerce Kit (ACK-ID/ACK-Pay), $30M Series A | Beatable because they're becoming a chartered FI that *holds funds* — ACTP's non-custodial neutrality is the wedge |
| 82 | **Skyfire** 🥊 | skyfire.xyz | Amir Sarhangi (Co-founder & CEO) | "Agent Trust Stack": KYA identity + wallet limits + merchant gating | Wallet-level and tied to its own crypto network; ACTP = neutral, cross-rail, merchant-trust *scoring* vs binary verified-agent |
| 83 | **Nekuda** 🥊 | nekuda.ai | Ayal Karmi (Co-founder & CEO) | Agentic mandates / spend policy / checkout (Visa launch partner) | Drifting to merchant-side "trust infrastructure"; single-rail vs ACTP's neutral cross-rail verdict |
| 84 | **Fime (FACT)** 🥊 *(closest positioning)* | fime.com | Lionel Grosclaude (CEO) | Payments testing/certification consultancy; launched FACT "independent neutral trust layer" (Apr 2026) | Near-verbatim ACTP positioning but a certification body, pre-pilot — beat on being live, non-custodial, developer-first software |
| 85 | **Forter (TACP)** ⚔️ | forter.com | Michael Reitblat (Co-founder & CEO) | Fraud/trust network; Trusted Agentic Commerce Protocol | Merchant-*side* fraud (protects the seller, not the buyer) — opposite side of the table; consume TACP as a signal |
| 86 | **Kite** 🥊 | gokite.ai | Chi Zhang (Co-founder & CEO) | L1 + Agent Passport: verified identity + spend limits | Its own chain; ACTP is neutral and cross-rail. PayPal/General Catalyst backed |
| 87 | **Alter** ⚔️ | alterauth.com | Srikar Dandamuraju (Co-founder & CEO) | Zero-trust identity/access control for agent tool calls (RBAC/ABAC) | Access control, *not* payments — ACTP is the payment-specific decision above its auth layer |

## 10 · Billing / metering & adjacent (skip or data-source)

| # | Company | Website | CEO / Founder | What they do | Relation to ACTP |
|--|--|--|--|--|--|
| 88 | **Paid.ai** 👀 | paid.ai | Manny Medina (Co-founder & CEO, ex-Outreach) | Results-based billing/monetization for AI agents | Billing, not money-movement — wrong layer; useful only as a data source |
| 89 | **Autumn** 👀 | useautumn.com | Ayush Rodrigues & John Yeo (co-founders) | OSS billing/pricing layer over Stripe | Wrong layer (pricing/checkout modeling), not a payment decision |
| 90 | **Oak** 👀 | oak.id | Shai Morag (Co-founder & CEO) | AI-native "Identity OS" — governs human/machine/agent identities & access | Governs identities/access, not payments; possible signal partner |

## 11 · Standards to align with (not sell to)

| # | Standard | Owner | What it is | How ACTP aligns |
|--|--|--|--|--|
| 91 | **Google AP2** 📐 | Google (+60 partners) | Agent Payments Protocol — signed Mandates as W3C VCs, rail-agnostic | Emit ACTP's verdict *as* an AP2-conformant mandate; AP2 proves intent, deliberately not merchant trust |
| 92 | **x402** 📐 | x402 Foundation (Coinbase + Cloudflare, Linux Foundation) | HTTP-native stablecoin transport, no policy/trust layer | The rail most in need of an external "should I pay this endpoint?" check — our live demo target |
| 93 | **Visa TAP / Mastercard Agent Pay** 📐 | Visa / Mastercard | Network agent-verification registries & tokens (agent→merchant auth) | Consume their signals; differentiate on the one thing a rail structurally can't be — a *neutral cross-rail* merchant arbiter |

---

### Top-6 first-conversation shortlist
1. **Coinbase x402** (Erik Reppel) — flagship rail, gap explicitly unbuilt; we've proven the integration live.
2. **Stripe** (Jeff Weinstein / product) & **Lithic** (Bo Jiang) — cleanest documented JIT auth webhooks.
3. **Composio** (Soham Ganatra) — owns the payment-tool distribution surface, single chokepoint.
4. **Lindy** (Flo Crivello) & **ElizaOS** (Shaw Walters) — agents that demonstrably transact today with no gate.

### Verification & hygiene notes
- **Unverified leadership** (do not attribute a name in outreach without a direct check): ACI.dev, PayAI (anonymous team), Wayfinder. **Unverified website**: /dev/agents.
- **Recent M&A / leadership shifts**: Privy→Stripe · ZeroDev→Offchain Labs · Web3Auth→Consensys · Dynamic→Fireblocks (least confirmed) · Portkey→Palo Alto Networks · Helicone→Mintlify · Brex→Capital One · Marqeta CEO now Mike Milotich · Ramp now co-CEO · Galileo interim CEO · Fordefi is a Paxos subsidiary.
- **Name-collision traps**: Radius (radiustech.xyz, crypto) ≠ Radius Payment Solutions (radius.com, UK fleet cards) · Arcade.dev ≠ Arcade Software · Glama (glama.ai) ≠ GlamAI (glam.ai) · Catena Labs (catena.com) ≠ Catena Media · Oak (oak.id) ≠ Oak Security · PayOS (payos.ai) ≠ payOS Vietnam · Billions (billions.network) ≠ the TV series/agency.
- All contact should use **public channels only** (LinkedIn / X / GitHub / docs). No personal emails were collected or invented.
