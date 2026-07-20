import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {parseAmount, formatAmount} from "@actp/core";
import {createDb, type Db} from "../db/client.js";
import {migrate} from "../db/migrations.js";
import {PrincipalService} from "./principals.js";
import {BudgetService} from "./budgets.js";

let db: Db;

beforeEach(async () => {
  db = await createDb();
  await migrate(db);
});
afterEach(async () => {
  await db.close();
});

describe("principals + delegation", () => {
  it("builds an org -> department -> agent chain", async () => {
    const svc = new PrincipalService(db);
    const org = await svc.createOrg("Acme Inc");
    const dept = await svc.createChild(org.id, "department", "Engineering");
    const agent = await svc.createChild(dept.id, "agent", "CI Bot");

    const chain = await svc.chain(agent.id);
    expect(chain.map((p) => p.kind)).toEqual(["agent", "department", "org"]);
    expect(chain[2]!.id).toBe(org.id);
    expect(agent.orgId).toBe(org.id);
  });

  it("uses the nearest policy up the chain", async () => {
    const svc = new PrincipalService(db);
    const org = await svc.createOrg("Acme");
    const agent = await svc.createChild(org.id, "agent", "Bot");
    await svc.setPolicy(org.id, {
      schema: "actp.policy.v1",
      version: "1.0.0",
      normalizedCurrency: "USD",
      statements: [{id: "s1", effect: "allow", when: []}],
    });
    const eff = await svc.effectivePolicy(agent.id);
    expect(eff?.statements[0]!.id).toBe("s1");
  });

  it("delegation only narrows: min amount, intersect rails, union denies", async () => {
    const svc = new PrincipalService(db);
    const org = await svc.createOrg("Acme");
    const dept = await svc.createChild(org.id, "department", "Eng");
    const agent = await svc.createChild(dept.id, "agent", "Bot");

    await svc.createDelegation(org.id, dept.id, {maxAmount: "1000", rails: ["card", "x402"], deniedVendors: ["0xaaa"]});
    await svc.createDelegation(dept.id, agent.id, {maxAmount: "250", rails: ["x402"], deniedVendors: ["0xbbb"]});

    const eff = await svc.effectiveConstraints(agent.id);
    expect(formatAmount(eff.maxAmountMicros!)).toBe("250"); // min(1000, 250)
    expect(eff.rails).toEqual(["x402"]); // intersect({card,x402},{x402})
    expect(eff.deniedVendors).toEqual(new Set(["0xaaa", "0xbbb"])); // union
    expect(eff.sources).toHaveLength(2);
  });

  it("marks constraints expired when a delegation lapses", async () => {
    const svc = new PrincipalService(db);
    const org = await svc.createOrg("Acme");
    const agent = await svc.createChild(org.id, "agent", "Bot");
    await svc.createDelegation(org.id, agent.id, {maxAmount: "100", expiresAt: "2020-01-01T00:00:00Z"});
    const eff = await svc.effectiveConstraints(agent.id);
    expect(eff.expired).toBe(true);
  });

  it("a suspended ancestor blocks the whole chain", async () => {
    const svc = new PrincipalService(db);
    const org = await svc.createOrg("Acme");
    const dept = await svc.createChild(org.id, "department", "Eng");
    const agent = await svc.createChild(dept.id, "agent", "Bot");
    await svc.setStatus(dept.id, "suspended");
    const {active, suspended} = await svc.chainActive(agent.id);
    expect(active).toBe(false);
    expect(suspended).toBe(dept.id);
  });
});

describe("cross-rail budgets", () => {
  const fx = new Map([
    ["USD", "1"],
    ["USDC", "1"],
    ["EUR", "1.08"],
  ]);

  it("aggregates spend across rails/currencies against one normalized cap", async () => {
    const svc = new PrincipalService(db);
    const budgets = new BudgetService(db, fx, 3600);
    const org = await svc.createOrg("Acme");
    const agent = await svc.createChild(org.id, "agent", "Bot");
    const chain = (await svc.chain(agent.id)).map((p) => p.id);

    await budgets.createBudget(org.id, "month", "USD", "100"); // $100/mo across all rails

    // card USD 40, then x402 USDC 40 -> 80 used, both settle
    let r = await budgets.checkAndHold(chain, agent.id, "d1", {value: "40", currency: "USD"});
    expect(r.ok).toBe(true);
    await budgets.settle("d1");
    r = await budgets.checkAndHold(chain, agent.id, "d2", {value: "40", currency: "USDC"});
    expect(r.ok).toBe(true);
    await budgets.settle("d2");

    // a EUR 20 charge normalizes to $21.60 -> 80 + 21.6 = 101.6 > 100 -> blocked
    r = await budgets.checkAndHold(chain, agent.id, "d3", {value: "20", currency: "EUR"});
    expect(r.ok).toBe(false);
    expect(r.violation?.currency).toBe("USD");
    expect(r.violation?.wouldBe).toBe("101.6");
  });

  it("holds count against the cap even before settlement (no double-spend for shared treasury)", async () => {
    const svc = new PrincipalService(db);
    const budgets = new BudgetService(db, fx, 3600);
    const org = await svc.createOrg("Acme");
    const a1 = await svc.createChild(org.id, "agent", "Bot1");
    const a2 = await svc.createChild(org.id, "agent", "Bot2");
    await budgets.createBudget(org.id, "total", "USD", "100");

    const c1 = (await svc.chain(a1.id)).map((p) => p.id);
    const c2 = (await svc.chain(a2.id)).map((p) => p.id);

    const r1 = await budgets.checkAndHold(c1, a1.id, "d1", {value: "70", currency: "USD"});
    expect(r1.ok).toBe(true); // held, not yet settled
    const r2 = await budgets.checkAndHold(c2, a2.id, "d2", {value: "40", currency: "USD"});
    expect(r2.ok).toBe(false); // 70 held + 40 > 100
  });

  it("releasing a hold frees the budget", async () => {
    const svc = new PrincipalService(db);
    const budgets = new BudgetService(db, fx, 3600);
    const org = await svc.createOrg("Acme");
    const agent = await svc.createChild(org.id, "agent", "Bot");
    const chain = (await svc.chain(agent.id)).map((p) => p.id);
    await budgets.createBudget(org.id, "total", "USD", "100");

    await budgets.checkAndHold(chain, agent.id, "d1", {value: "80", currency: "USD"});
    let r = await budgets.checkAndHold(chain, agent.id, "d2", {value: "30", currency: "USD"});
    expect(r.ok).toBe(false);
    await budgets.release("d1");
    r = await budgets.checkAndHold(chain, agent.id, "d3", {value: "30", currency: "USD"});
    expect(r.ok).toBe(true);
  });

  it("enforces per-agent and org budgets together (both must pass)", async () => {
    const svc = new PrincipalService(db);
    const budgets = new BudgetService(db, fx, 3600);
    const org = await svc.createOrg("Acme");
    const agent = await svc.createChild(org.id, "agent", "Bot");
    const chain = (await svc.chain(agent.id)).map((p) => p.id);
    await budgets.createBudget(org.id, "month", "USD", "1000");
    await budgets.createBudget(agent.id, "day", "USD", "50"); // tight per-agent daily

    const r = await budgets.checkAndHold(chain, agent.id, "d1", {value: "60", currency: "USD"});
    expect(r.ok).toBe(false); // org ok but agent daily 50 exceeded
    expect(r.violation?.period).toBe("day");
  });

  it("normalizes FX correctly", () => {
    const budgets = new BudgetService(db, fx, 3600);
    expect(formatAmount(budgets.normalize({value: "100", currency: "EUR"}, "USD").micros)).toBe("108");
    expect(formatAmount(budgets.normalize({value: "100", currency: "USDC"}, "USD").micros)).toBe("100");
    expect(() => budgets.normalize({value: "1", currency: "GBP"}, "USD")).toThrow();
  });
});
