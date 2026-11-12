"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { agentTick, latestStore } from "@/lib/client/agent";
import { caseStatus } from "@/lib/client/store";
import { Role, useStore } from "@/lib/client/store";

const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: "buyer", label: "Buyer", hint: "Invites vendors and sets how much checking they need" },
  { id: "vendor", label: "Vendor", hint: "Fills in details and uploads documents" },
  { id: "reviewer", label: "Reviewer", hint: "Decides unclear cases and teaches the system" },
];

const NAV: { href: string; label: string; roles: Role[] }[] = [
  { href: "/", label: "Cases", roles: ["buyer", "reviewer", "vendor"] },
  { href: "/invite", label: "Invite a vendor", roles: ["buyer"] },
  { href: "/review", label: "Review queue", roles: ["reviewer"] },
  { href: "/dashboard", label: "Dashboard", roles: ["buyer", "reviewer"] },
  { href: "/outbox", label: "Messages", roles: ["buyer", "reviewer"] },
  { href: "/policy", label: "Rules", roles: ["reviewer", "buyer"] },
  { href: "/governance", label: "Governance", roles: ["reviewer", "buyer"] },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  const s = useStore();
  const path = usePathname();
  const offset = s.clockOffsetDays;
  latestStore.current = s;
  const queue = s.cases.filter((c) => caseStatus(c) === "PENDING_INTERNAL").length;

  // The follow-up agent acts whenever simulated time moves forward.
  useEffect(() => {
    if (s.ready) agentTick(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.clockOffsetDays, s.ready]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 px-4 pt-4">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-white/70 bg-white/75 px-5 py-3 shadow-[0_8px_30px_rgba(60,70,120,0.10)] backdrop-blur-md">
          <Link href="/" className="flex items-center gap-2 font-extrabold tracking-tight text-[17px]">
            <span className="grad-bar flex h-7 w-7 items-center justify-center rounded-lg" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 16 16">
                <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" fill="none" stroke="#141826" strokeWidth="1.5" />
                <path d="M5 6h6M5 9h6M5 12h3" stroke="#141826" strokeWidth="1.4" />
              </svg>
            </span>
            Vendor Onboarding
          </Link>
          <nav className="-mx-1 order-last flex w-full gap-1 overflow-x-auto md:order-none md:w-auto" aria-label="Main">
            {NAV.filter((n) => n.roles.includes(s.role)).map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`shrink-0 whitespace-nowrap rounded px-2.5 py-1 text-[14px] ${path === n.href ? "bg-tint font-semibold" : "text-ink-2 hover:text-ink"}`}
              >
                {n.label}
                {n.href === "/review" && queue > 0 && (
                  <span className="ml-1.5 rounded-full bg-review px-1.5 text-[12px] font-semibold text-white">{queue}</span>
                )}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {offset > 0 && (
              <span className="text-[13px] text-wait" title="Simulated clock for the demo">
                Clock +{offset} day{offset > 1 ? "s" : ""}
              </span>
            )}
            <div role="radiogroup" aria-label="Viewing as" className="flex rounded-md border border-rule-strong p-0.5">
              {ROLES.map((r) => (
                <button
                  key={r.id}
                  role="radio"
                  aria-checked={s.role === r.id}
                  title={r.hint}
                  onClick={() => s.setRole(r.id)}
                  className={`rounded px-2.5 py-1 text-[13px] font-semibold ${s.role === r.id ? "bg-ink text-white" : "text-ink-2 hover:bg-tint"}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button
              className="text-[13px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
              onClick={() => {
                if (confirmReset()) s.reset();
              }}
            >
              Reset demo
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1240px] px-4 py-6">{s.ready ? children : <p className="text-ink-3">Loading…</p>}</main>
      <footer className="mx-auto max-w-[1240px] border-t border-rule px-4 py-5 text-[13px] text-ink-3">
        Built by <span className="font-semibold text-ink-2">Aarchi Kothari</span> · IIT Roorkee · 23410001 · AI Solutions Analyst case study, problem statement 2 ·{" "}
        <a className="underline" href="https://github.com/codingcat101/vendor-onboarding" target="_blank" rel="noreferrer">Code on GitHub</a>
        <span className="block sm:inline"> · All companies and documents are fictional samples.</span>
      </footer>
    </div>
  );
}

// A native confirm would block automation; a simple inline toggle is enough for a demo reset.
let armed = 0;
function confirmReset() {
  const now = Date.now();
  if (now - armed < 4000) return true;
  armed = now;
  const el = document.activeElement as HTMLElement | null;
  if (el) {
    const old = el.textContent;
    el.textContent = "Click again to erase everything";
    setTimeout(() => (el.textContent = old), 4000);
  }
  return false;
}
