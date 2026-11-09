// IFSC lookup against Razorpay's open IFSC dataset (MIT licence, bundled in data/ifsc).
// Works offline, so a live demo never depends on a third-party API being up.
import ifscData from "../../data/ifsc/IFSC.json";
import bankNames from "../../data/ifsc/banknames.json";
import { IFSC_RE, clean } from "./ids";

const DATA = ifscData as unknown as Record<string, (number | string)[]>;
const NAMES = bankNames as unknown as Record<string, string>;
const cache = new Map<string, Set<string>>();

function branchesOf(bank: string) {
  let s = cache.get(bank);
  if (!s) {
    s = new Set((DATA[bank] ?? []).map((b) => (typeof b === "number" ? String(b).padStart(6, "0") : b)));
    cache.set(bank, s);
  }
  return s;
}

export type IfscLookup =
  | { found: true; ifsc: string; bankCode: string; bankName: string }
  | { found: false; ifsc: string; reason: "format" | "unknown_bank" | "unknown_branch"; bankName?: string };

export function lookupIfsc(raw: string | undefined): IfscLookup {
  const ifsc = clean(raw);
  if (!IFSC_RE.test(ifsc)) return { found: false, ifsc, reason: "format" };
  const bankCode = ifsc.slice(0, 4);
  if (!DATA[bankCode]) return { found: false, ifsc, reason: "unknown_bank" };
  if (!branchesOf(bankCode).has(ifsc.slice(5))) return { found: false, ifsc, reason: "unknown_branch", bankName: NAMES[bankCode] };
  return { found: true, ifsc, bankCode, bankName: NAMES[bankCode] ?? bankCode };
}

/** Optional live enrichment (branch, city) from ifsc.razorpay.com. Never required for a decision. */
export async function fetchBranchDetails(ifsc: string, timeoutMs = 2500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`https://ifsc.razorpay.com/${clean(ifsc)}`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return { branch: j.BRANCH as string, city: j.CITY as string, state: j.STATE as string, address: j.ADDRESS as string };
  } catch {
    return null;
  }
}
