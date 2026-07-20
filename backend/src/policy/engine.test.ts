import {describe, expect, it} from "vitest";
import {parsePolicyText, type PolicyContext} from "@actp/core";
import {evaluatePolicy} from "./engine.js";

const POLICY = parsePolicyText(
  `
  [no-crit]   deny when risk.level == "critical"
  [active]    deny when vendor.status != "active"
  [young]     deny when vendor.domainAgeDays < 90
  [big]       require_approval when amount > 250
  [subs]      require_approval when subscription == true
  [verified]  allow when vendor.verificationLevel >= 3 and category in ["software", "api"]
  [x402-ok]   allow when rail == "x402" and amount <= 50
  `,
  {version: "1.0.0"},
);

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    amount: 10,
    currency: "USD",
    rail: "card",
    category: "software",
    subscription: false,
    vendor: {known: true, status: "active", verificationLevel: 3, registryAgeDays: 400, domainAgeDays: 800},
    risk: {level: "low", score: 5},
    contract: {subscription: false, autoRenews: false, arbitration: false, earlyTerminationFee: false},
    time: {hourUtc: 12},
    ...over,
  };
}

describe("evaluatePolicy", () => {
  it("allows a verified low-risk software purchase", () => {
    const r = evaluatePolicy(POLICY, ctx());
    expect(r.outcome).toBe("allow");
    expect(r.determiningStatement).toBe("verified");
  });

  it("deny overrides allow (critical risk beats a verified vendor)", () => {
    const r = evaluatePolicy(POLICY, ctx({risk: {level: "critical", score: 95}}));
    expect(r.outcome).toBe("deny");
    expect(r.determiningStatement).toBe("no-crit");
    expect(r.fired.some((f) => f.id === "verified")).toBe(true); // both fired; deny wins
  });

  it("require_approval overrides allow but not deny", () => {
    const approval = evaluatePolicy(POLICY, ctx({amount: 500}));
    expect(approval.outcome).toBe("require_approval");
    expect(approval.determiningStatement).toBe("big");

    const denyWins = evaluatePolicy(POLICY, ctx({amount: 500, vendor: {...ctx().vendor, status: "suspended"}}));
    expect(denyWins.outcome).toBe("deny");
  });

  it("fails closed when nothing explicitly allows", () => {
    // uncategorized card purchase from a verified vendor: no allow statement matches
    const r = evaluatePolicy(POLICY, ctx({category: "gambling"}));
    expect(r.outcome).toBe("deny");
    expect(r.determiningStatement).toBeNull();
    expect(r.fired).toHaveLength(0);
  });

  it("treats an unknown numeric attribute as failing an ordering (fail closed)", () => {
    // domainAgeDays null must NOT satisfy 'domainAgeDays < 90' (that would deny) nor pass any
    // allow that needs a number; here null means the [young] deny does not fire, but the
    // allow still requires verificationLevel/category which do hold -> allow, and null age
    // never trips the young-domain deny incorrectly.
    const r = evaluatePolicy(POLICY, ctx({vendor: {...ctx().vendor, domainAgeDays: null}}));
    expect(r.fired.some((f) => f.id === "young")).toBe(false);
    expect(r.outcome).toBe("allow");
  });

  it("young domain is denied", () => {
    const r = evaluatePolicy(POLICY, ctx({vendor: {...ctx().vendor, domainAgeDays: 30}}));
    expect(r.outcome).toBe("deny");
    expect(r.determiningStatement).toBe("young");
  });

  it("is deterministic and explains every fired statement with evidence", () => {
    const c = ctx({amount: 500, subscription: true});
    const a = evaluatePolicy(POLICY, c);
    const b = evaluatePolicy(POLICY, {...c});
    expect(a).toEqual(b);
    const ids = a.fired.map((f) => f.id);
    expect(ids).toContain("big");
    expect(ids).toContain("subs");
    for (const f of a.fired) {
      for (const cond of f.conditions) expect(cond.held).toBe(true);
    }
  });

  it("x402 micro-purchase auto-allows under the rail rule", () => {
    const r = evaluatePolicy(POLICY, ctx({rail: "x402", category: "data", amount: 0.02, vendor: {...ctx().vendor, verificationLevel: 1}}));
    expect(r.outcome).toBe("allow");
    expect(r.determiningStatement).toBe("x402-ok");
  });
});
