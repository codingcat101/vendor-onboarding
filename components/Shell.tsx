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
      <header className="bg-[var(--forest)] bg-[url('/texture.png')] bg-cover bg-center px-4 py-5 [image-rendering:pixelated]">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl bg-sheet px-5 py-3 shadow-[0_8px_30px_rgba(6,30,18,0.35)] [image-rendering:auto]">
          <Link href="/" className="flex items-center gap-2 font-extrabold tracking-tight text-[17px]">
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
              <rect x="2" y="3" width="15" height="17" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M5.5 8h8M5.5 11.5h8M5.5 15h4.5" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="16.5" cy="16" r="4.2" fill="var(--magenta)" />
              <path d="M14.6 16l1.3 1.3 2.3-2.5" stroke="#fff" strokeWidth="1.5" fill="none" />
            </svg>
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
