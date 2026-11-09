// Runs the checks and turns their results into a decision.
import { CHECKS, Ctx } from "./checks";
import { Policy, computeTier } from "./policy";
import type {
  CheckResult, Decision, DocSlot, ExistingVendor, ExtractedDoc, Invite, RunResult, Severity, Submission,
} from "./types";

export interface RunInput {
  sub: Submission;
  invite: Invite;
  docs: Partial<Record<DocSlot, ExtractedDoc>>;
  master: ExistingVendor[];
  policy: Policy;
  /** For a resubmission: the previous run and which inputs changed. Unchanged checks are carried over. */
  previous?: RunResult;
  changed?: string[];
}

const depHit = (deps: string[], changed: string[]) =>
  deps.some((d) => changed.some((c) => c === d || c.startsWith(d + ".") || d.startsWith(c + ".")));

export function runOnboarding(input: RunInput): RunResult {
  const { tier } = computeTier(input.invite, input.policy);
  const ctx: Ctx = { sub: input.sub, invite: input.invite, tier, policy: input.policy, docs: input.docs, master: input.master };
  const prevById = new Map((input.previous?.checks ?? []).map((c) => [c.id, c]));
  const rechecked: string[] = [];

  const checks: CheckResult[] = [];
  for (const def of CHECKS) {
    if (def.applies && !def.applies(ctx)) continue;
    const prev = prevById.get(def.id);
    if (input.previous && input.changed && prev && !depHit(def.deps, input.changed)) {
      checks.push({ ...prev, carried_over: true });
      continue;
    }
    rechecked.push(def.id);
    checks.push({ id: def.id, stage: def.stage, title: def.title, ...def.run(ctx) });
  }

  return {
    tier,
    policy_version: input.policy.version,
    checks,
    decision: decide(checks, tier),
    rechecked: input.previous ? rechecked : undefined,
  };
}

const RANK: Record<Severity, number> = { fraud: 3, vendor_fixable: 2, needs_review: 1 };

export function decide(checks: CheckResult[], tier: RunResult["tier"]): Decision {
  const failed = checks.filter((c) => c.outcome === "fail");
  const reasons = failed
    .sort((a, b) => RANK[b.severity!] - RANK[a.severity!])
    .map((c) => ({ code: c.code!, severity: c.severity!, message: c.message }));
  const vendor_actions = failed
    .filter((c) => c.severity === "vendor_fixable")
    .map((c) => ({ code: c.code!, message: c.vendor_message ?? c.message }));

  const has = (s: Severity) => failed.some((c) => c.severity === s);
  if (has("fraud"))
    return {
      status: "REJECTED", reasons, vendor_actions: [],
      summary: (() => { const n = failed.filter((c) => c.severity === "fraud").length; return `${n === 1 ? "One integrity problem" : `${n} integrity problems`}. ${reasons[0].message}`; })(),
    };
  if (has("vendor_fixable"))
    return {
      status: "PENDING_VENDOR", reasons, vendor_actions,
      summary: vendor_actions.length === 1 ? "One thing for the vendor to fix" : `${vendor_actions.length} things for the vendor to fix`,
    };
  if (has("needs_review"))
    return {
      status: "PENDING_INTERNAL", reasons, vendor_actions: [],
      summary: reasons.map((r) => r.message).join("; "),
    };
  if (tier === "STRATEGIC")
    return {
      status: "PENDING_INTERNAL", vendor_actions: [],
      reasons: [{ code: "STRATEGIC_SIGNOFF_REQUIRED", severity: "signoff", message: "Strategic vendor: all checks passed, a person must sign off" }],
      summary: "All checks passed. Strategic tier, so it waits for a person to sign off.",
    };
  return { status: "APPROVED", reasons: [], vendor_actions: [], summary: `All ${checks.filter((c) => c.outcome === "pass").length} checks passed` };
}

export { diffInputs } from "./diff";
