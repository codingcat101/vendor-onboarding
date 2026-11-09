"use client";
// Per-visitor sandbox: every case, the policy and the message outbox live in this browser.
// Each Zamp reviewer who opens the link gets an isolated, resettable demo.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_POLICY, Policy, computeTier } from "@/lib/engine/policy";
import type { DocSlot, ExistingVendor, ExtractedDoc, Invite, RunResult, Status, Submission, Tier } from "@/lib/engine/types";

export type Role = "buyer" | "vendor" | "reviewer";

export type Reading = ExtractedDoc & { notes?: string; ms?: number; error?: string; model?: string };

export interface CaseRun extends RunResult {
  at: string;
  trigger: "submission" | "resubmission" | "policy_change";
  changed?: string[];
  inputs: { sub: Submission; docs: Partial<Record<DocSlot, Reading>> };
}

export interface AuditEvent {
  at: string;
  actor: string;
  text: string;
  kind: "invite" | "submit" | "decision" | "message" | "review" | "policy" | "reminder" | "escalation" | "expiry";
}

export type CaseStatus = Status | "INVITED" | "EXPIRED";

export interface Case {
  id: string;
  invite: Invite & { vendor_name: string; vendor_email: string };
  tier: Tier;
  tier_why: string;
  scenario?: string;
  created_at: string;
  sub?: Submission;
  readings: Partial<Record<DocSlot, Reading>>;
  runs: CaseRun[];
  events: AuditEvent[];
  /** A person's final call (sign-off, override). Overrides the last run's status. */
  final?: { status: Status; by: string; note: string; at: string };
  expired_at?: string;
}

export interface OutboxMessage {
  id: string;
  case_id: string;
  at: string;
  to: string;
  subject: string;
  body: string;
  kind: "request" | "reminder" | "escalation" | "approved" | "rejected";
}

interface State {
  role: Role;
  cases: Case[];
  policy: Policy;
  outbox: OutboxMessage[];
  clockOffsetDays: number;
}

const KEY = "vendor-onboarding-sandbox-v1";
const initial: State = { role: "buyer", cases: [], policy: DEFAULT_POLICY, outbox: [], clockOffsetDays: 0 };

export function caseStatus(c: Case): CaseStatus {
  if (c.final) return c.final.status;
  if (c.expired_at) return "EXPIRED";
  const last = c.runs.at(-1);
  return last ? last.decision.status : "INVITED";
}

export function caseName(c: Case) {
  return c.sub?.trade_name || c.sub?.legal_name || c.invite.vendor_name;
}

interface Store extends State {
  ready: boolean;
  now: () => Date;
  setRole: (r: Role) => void;
  createCase: (invite: Case["invite"], scenario?: string) => Case;
  updateCase: (id: string, fn: (c: Case) => Case) => void;
  addEvent: (id: string, e: Omit<AuditEvent, "at">) => void;
  setPolicy: (p: Policy) => void;
  addMessage: (m: Omit<OutboxMessage, "id" | "at">) => void;
  advanceClock: (days: number) => void;
  reset: () => void;
  approvedVendors: () => ExistingVendor[];
  getCase: (id: string) => Case | undefined;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>(initial);
  const [ready, setReady] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setState({ ...initial, ...JSON.parse(raw) });
    } catch {
      /* private mode or blocked storage: start fresh, still works in memory */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, ready]);

  const now = useCallback(() => new Date(Date.now() + stateRef.current.clockOffsetDays * 86_400_000), []);
  const iso = useCallback(() => now().toISOString(), [now]);

  const store = useMemo<Store>(
    () => ({
      ...state,
      ready,
      now,
      setRole: (role) => setState((s) => ({ ...s, role })),
      createCase: (invite, scenario) => {
        const { tier, why } = computeTier(invite, stateRef.current.policy);
        const n = stateRef.current.cases.length + 1;
        const c: Case = {
          id: `VO-${String(1000 + n)}${Math.random().toString(36).slice(2, 4).toUpperCase()}`,
          invite, tier, tier_why: why, scenario, created_at: iso(), readings: {}, runs: [],
          events: [{ at: iso(), actor: invite.buyer, kind: "invite", text: `Invited ${invite.vendor_name} (${invite.category}). Tier ${tier}: ${why}.` }],
        };
        setState((s) => ({ ...s, cases: [c, ...s.cases] }));
        return c;
      },
      updateCase: (id, fn) => setState((s) => ({ ...s, cases: s.cases.map((c) => (c.id === id ? fn(c) : c)) })),
      addEvent: (id, e) =>
        setState((s) => ({ ...s, cases: s.cases.map((c) => (c.id === id ? { ...c, events: [...c.events, { ...e, at: iso() }] } : c)) })),
      setPolicy: (policy) => setState((s) => ({ ...s, policy })),
      addMessage: (m) =>
        setState((s) => ({ ...s, outbox: [{ ...m, id: Math.random().toString(36).slice(2), at: iso() }, ...s.outbox] })),
      advanceClock: (days) => setState((s) => ({ ...s, clockOffsetDays: s.clockOffsetDays + days })),
      reset: () => {
        try {
          localStorage.removeItem(KEY);
        } catch {
          /* ignore */
        }
        setState({ ...initial, role: stateRef.current.role });
      },
      approvedVendors: () =>
        stateRef.current.cases
          .filter((c) => caseStatus(c) === "APPROVED" && c.sub)
          .map((c) => ({
            vendor_id: c.id, legal_name: c.sub!.legal_name, gstin: c.sub!.gstin ?? "", pan: c.sub!.pan ?? "",
            state: c.sub!.address.state, status: "ACTIVE",
            bank: { account_number: c.sub!.bank.account_number, ifsc: c.sub!.bank.ifsc ?? "", bank_name: c.sub!.bank.bank_name },
          })),
      getCase: (id) => stateRef.current.cases.find((c) => c.id === id),
    }),
    [state, ready, now, iso],
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
}
