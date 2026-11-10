"use client";
import type { CaseStatus } from "@/lib/client/store";
import type { Tier } from "@/lib/engine/types";

export const STATUS_META: Record<CaseStatus, { label: string; stamp: string; color: string; bg: string }> = {
  APPROVED: { label: "Approved", stamp: "Approved", color: "var(--approve)", bg: "var(--approve-bg)" },
  REJECTED: { label: "Rejected", stamp: "Rejected", color: "var(--reject)", bg: "var(--reject-bg)" },
  PENDING_INTERNAL: { label: "Pending: review", stamp: "Pending", color: "var(--review)", bg: "var(--review-bg)" },
  PENDING_VENDOR: { label: "Pending: vendor", stamp: "Pending", color: "var(--wait)", bg: "var(--wait-bg)" },
  INVITED: { label: "Invited", stamp: "Invited", color: "var(--ink-2)", bg: "var(--tint)" },
  EXPIRED: { label: "Expired", stamp: "Expired", color: "var(--ink-3)", bg: "var(--tint)" },
};

export function StatusBadge({ status }: { status: CaseStatus }) {
  const m = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap"
      style={{ color: m.color, background: m.bg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} aria-hidden />
      {m.label}
    </span>
  );
}

export function Stamp({ status, sub, animate }: { status: CaseStatus; sub?: string; animate?: boolean }) {
  const m = STATUS_META[status];
  return (
    <div className={`stamp ${animate ? "stamp-land" : ""}`} style={{ color: m.color }} role="img" aria-label={`Status: ${m.label}`}>
      {m.stamp}
      {sub && <small>{sub}</small>}
    </div>
  );
}

const TIER_LABEL: Record<Tier, string> = { LOW: "Low risk", STANDARD: "Standard", STRATEGIC: "Strategic" };
export function TierTag({ tier, why }: { tier: Tier; why?: string }) {
  return (
    <span title={why} className="inline-flex items-center rounded border border-rule-strong px-2 py-0.5 text-[13px] text-ink-2 whitespace-nowrap">
      {TIER_LABEL[tier]} tier
    </span>
  );
}

export const inr = (n: number) =>
  n >= 10_000_000 ? `₹${(n / 10_000_000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr` : `₹${(n / 100_000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;

export function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function Section({ title, aside, children, className = "" }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-rule bg-sheet ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
        <h2 className="text-[15px] font-bold">{title}</h2>
        {aside}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
