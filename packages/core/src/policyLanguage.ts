import {
  POLICY_ATTRIBUTES,
  validatePolicy,
  type Condition,
  type PolicyDocument,
  type PolicyOperator,
  type Statement,
} from "./policy.js";

/**
 * ACTP V11 — human-readable policy surface.
 *
 * Authors write compact lines that compile to the validated JSON policy model:
 *
 *   deny when risk.level == "critical"
 *   deny when vendor.status != "active"
 *   require_approval when amount > 250
 *   require_approval when subscription == true
 *   allow when vendor.verificationLevel >= 3 and category in ["software", "api"]
 *
 * One line = one statement. Conditions after `when` are AND-joined. `#` starts a comment.
 * An optional `[id]` prefix names the statement (auto-numbered s1, s2, … otherwise).
 * This is a thin surface over the JSON AST — not a new semantics — so it stays decidable.
 */

const TEXT_OPS: {text: string; op: PolicyOperator; exists?: boolean}[] = [
  {text: ">=", op: "gte"},
  {text: "<=", op: "lte"},
  {text: "==", op: "eq"},
  {text: "!=", op: "ne"},
  {text: ">", op: "gt"},
  {text: "<", op: "lt"},
  {text: "not in", op: "nin"},
  {text: "in", op: "in"},
  {text: "not exists", op: "exists", exists: false},
  {text: "exists", op: "exists", exists: true},
];

const OP_TO_TEXT: Record<PolicyOperator, string> = {
  gte: ">=",
  lte: "<=",
  eq: "==",
  ne: "!=",
  gt: ">",
  lt: "<",
  nin: "not in",
  in: "in",
  exists: "exists",
};

export class PolicyLanguageError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
  ) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "PolicyLanguageError";
  }
}

export function parsePolicyText(
  text: string,
  opts: {version: string; normalizedCurrency?: string},
): PolicyDocument {
  const statements: Statement[] = [];
  const lines = text.split("\n");
  let auto = 0;

  lines.forEach((raw, i) => {
    const line = stripComment(raw).trim();
    if (!line) return;

    let rest = line;
    let id: string | undefined;
    const idMatch = rest.match(/^\[([a-z0-9._-]+)\]\s*/i);
    if (idMatch) {
      id = idMatch[1];
      rest = rest.slice(idMatch[0].length);
    }

    const effMatch = rest.match(/^(allow|deny|require_approval)\b/);
    if (!effMatch) throw new PolicyLanguageError(`expected allow|deny|require_approval`, i + 1);
    const effect = effMatch[1] as Statement["effect"];
    rest = rest.slice(effMatch[0].length).trim();

    let when: Condition[] = [];
    if (rest.length > 0) {
      if (!/^when\b/.test(rest)) throw new PolicyLanguageError(`expected 'when' or end of line`, i + 1);
      rest = rest.slice(4).trim();
      when = splitConditions(rest).map((c) => parseCondition(c, i + 1));
    }

    statements.push({id: id ?? `s${++auto}`, effect, when});
  });

  if (statements.length === 0) throw new PolicyLanguageError("policy has no statements");

  return validatePolicy({
    schema: "actp.policy.v1",
    version: opts.version,
    normalizedCurrency: opts.normalizedCurrency ?? "USD",
    statements,
  });
}

export function renderPolicyText(doc: PolicyDocument): string {
  const header = `# actp.policy.v1  version ${doc.version}  normalized ${doc.normalizedCurrency}`;
  const body = doc.statements.map((s) => {
    const conds = s.when.map(renderCondition).join(" and ");
    const core = s.when.length ? `${s.effect} when ${conds}` : s.effect;
    return `[${s.id}] ${core}`;
  });
  return [header, ...body].join("\n") + "\n";
}

// --- internals -------------------------------------------------------------

function stripComment(line: string): string {
  const idx = indexOfUnquoted(line, "#");
  return idx === -1 ? line : line.slice(0, idx);
}

/** Split on top-level " and " (not inside quotes or brackets). */
function splitConditions(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') inStr = !inStr;
    if (!inStr && c === "[") depth++;
    if (!inStr && c === "]") depth--;
    if (!inStr && depth === 0 && s.slice(i, i + 5).toLowerCase() === " and ") {
      parts.push(buf.trim());
      buf = "";
      i += 4;
      continue;
    }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function parseCondition(text: string, line: number): Condition {
  for (const {text: opText, op, exists} of TEXT_OPS) {
    const idx = findOp(text, opText);
    if (idx === -1) continue;
    const attr = text.slice(0, idx).trim();
    const rhs = text.slice(idx + opText.length).trim();
    if (!(attr in POLICY_ATTRIBUTES)) {
      throw new PolicyLanguageError(`unknown attribute '${attr}'`, line);
    }
    if (op === "exists") {
      return {attr: attr as Condition["attr"], op, value: exists as boolean};
    }
    return {attr: attr as Condition["attr"], op, value: parseValue(rhs, line)};
  }
  throw new PolicyLanguageError(`could not parse condition: ${JSON.stringify(text)}`, line);
}

/** Find an operator token at a word boundary outside quotes/brackets. */
function findOp(text: string, opText: string): number {
  let inStr = false;
  let depth = 0;
  for (let i = 0; i <= text.length - opText.length; i++) {
    const c = text[i]!;
    if (c === '"') inStr = !inStr;
    if (!inStr && c === "[") depth++;
    if (!inStr && c === "]") depth--;
    if (inStr || depth > 0) continue;
    if (text.slice(i, i + opText.length) !== opText) continue;
    // word ops (in/not in/exists) need surrounding spaces; symbol ops don't
    if (/^[a-z ]+$/.test(opText)) {
      const before = text[i - 1];
      const after = text[i + opText.length];
      if (before !== " " || (after !== undefined && after !== " ")) continue;
    }
    return i;
  }
  return -1;
}

function parseValue(raw: string, line: number): Condition["value"] {
  const s = raw.trim();
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new PolicyLanguageError(`unterminated array: ${raw}`, line);
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ",").map((e) => parseScalar(e.trim(), line) as string | number);
  }
  return parseScalar(s, line);
}

function parseScalar(s: string, line: number): string | number | boolean {
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new PolicyLanguageError(`unterminated string: ${s}`, line);
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s; // bareword string (e.g. rail == card)
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let inStr = false;
  let buf = "";
  for (const c of s) {
    if (c === '"') inStr = !inStr;
    if (!inStr && c === sep) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

function indexOfUnquoted(s: string, ch: string): number {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') inStr = !inStr;
    else if (!inStr && s[i] === ch) return i;
  }
  return -1;
}

function renderCondition(c: Condition): string {
  const opText = OP_TO_TEXT[c.op];
  if (c.op === "exists") return `${c.attr} ${c.value === false ? "not exists" : "exists"}`;
  return `${c.attr} ${opText} ${renderValue(c.value)}`;
}

function renderValue(v: Condition["value"]): string {
  if (Array.isArray(v)) return `[${v.map(renderScalar).join(", ")}]`;
  return renderScalar(v);
}

function renderScalar(v: string | number | boolean): string {
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}
