import {describe, expect, it} from "vitest";
import {parsePolicyText, renderPolicyText, PolicyLanguageError} from "./policyLanguage.js";
import {validatePolicy} from "./policy.js";

const SAMPLE = `
# corporate spending policy
deny when risk.level == "critical"
deny when vendor.status != "active"
require_approval when amount > 250
require_approval when subscription == true
allow when vendor.verificationLevel >= 3 and category in ["software", "api"]
`;

describe("policy language", () => {
  it("parses the compact form into a valid policy document", () => {
    const doc = parsePolicyText(SAMPLE, {version: "1.0.0"});
    expect(doc.statements).toHaveLength(5);
    expect(doc.normalizedCurrency).toBe("USD");

    const deny = doc.statements[0]!;
    expect(deny.effect).toBe("deny");
    expect(deny.when[0]).toEqual({attr: "risk.level", op: "eq", value: "critical"});

    const approval = doc.statements[2]!;
    expect(approval.effect).toBe("require_approval");
    expect(approval.when[0]).toEqual({attr: "amount", op: "gt", value: 250});

    const allow = doc.statements[4]!;
    expect(allow.when).toHaveLength(2);
    expect(allow.when[0]).toEqual({attr: "vendor.verificationLevel", op: "gte", value: 3});
    expect(allow.when[1]).toEqual({attr: "category", op: "in", value: ["software", "api"]});
  });

  it("round-trips text -> doc -> text -> doc", () => {
    const doc1 = parsePolicyText(SAMPLE, {version: "1.0.0"});
    const text = renderPolicyText(doc1);
    const doc2 = parsePolicyText(text, {version: "1.0.0"});
    expect(doc2.statements).toEqual(doc1.statements);
  });

  it("handles 'not in', booleans, and bareword strings", () => {
    const doc = parsePolicyText(
      `deny when rail == card\nallow when category not in ["gambling", "adult"]\ndeny when contract.arbitration == true`,
      {version: "2.0.0"},
    );
    expect(doc.statements[0]!.when[0]).toEqual({attr: "rail", op: "eq", value: "card"});
    expect(doc.statements[1]!.when[0]).toEqual({attr: "category", op: "nin", value: ["gambling", "adult"]});
    expect(doc.statements[2]!.when[0]).toEqual({attr: "contract.arbitration", op: "eq", value: true});
  });

  it("supports effect with no conditions (always fires)", () => {
    const doc = parsePolicyText("deny", {version: "1.0.0"});
    expect(doc.statements[0]).toMatchObject({effect: "deny", when: []});
  });

  it("preserves explicit statement ids", () => {
    const doc = parsePolicyText("[no-crit] deny when risk.level == \"critical\"", {version: "1.0.0"});
    expect(doc.statements[0]!.id).toBe("no-crit");
  });

  it("rejects unknown attributes and malformed lines", () => {
    expect(() => parsePolicyText("deny when bogus.attr == 1", {version: "1.0.0"})).toThrow(PolicyLanguageError);
    expect(() => parsePolicyText("maybe when amount > 1", {version: "1.0.0"})).toThrow(PolicyLanguageError);
    expect(() => parsePolicyText("allow when amount", {version: "1.0.0"})).toThrow(PolicyLanguageError);
  });

  it("rejects a numeric operator on a non-numeric attribute at validation", () => {
    // rail is a string; > is nonsensical -> Zod superRefine rejects
    expect(() => parsePolicyText('deny when rail > 3', {version: "1.0.0"})).toThrow();
  });

  it("ignores comments and blank lines", () => {
    const doc = parsePolicyText("# a\n\n  # b\nallow when amount <= 10\n", {version: "1.0.0"});
    expect(doc.statements).toHaveLength(1);
  });

  it("produces documents that pass schema validation", () => {
    const doc = parsePolicyText(SAMPLE, {version: "1.0.0"});
    expect(() => validatePolicy(doc)).not.toThrow();
  });
});
