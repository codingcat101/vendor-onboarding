"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useStore } from "@/lib/client/store";
import { computeTier } from "@/lib/engine/policy";
import { DOC_LABEL } from "@/lib/engine/types";
import { Section, TierTag, inr } from "@/components/ui";

const CATEGORIES = [
  "Office stationery", "Packaging materials", "Housekeeping services", "Printing & signage", "Electrical supplies",
  "Machined components", "Logistics", "IT services / data analytics", "Professional services",
];

export default function InvitePage() {
  const s = useStore();
  const router = useRouter();
  const [f, setF] = useState({
    vendor_name: "", vendor_email: "", category: CATEGORIES[0], spend: "300000", data_access: false, buyer: "Priya Nair (Procurement)",
  });
  const spend = Number(f.spend.replace(/[^0-9]/g, "")) || 0;
  const invite = { buyer: f.buyer, category: f.category, annual_spend_inr: spend, data_access: f.data_access };
  const { tier, why } = computeTier(invite, s.policy);
  const docs = s.policy.required_docs[tier];
  const ok = f.vendor_name.trim() && /\S+@\S+\.\S+/.test(f.vendor_email);

  const send = () => {
    const c = s.createCase({ ...invite, vendor_name: f.vendor_name.trim(), vendor_email: f.vendor_email.trim() });
    router.push(`/cases/${c.id}`);
  };

  return (
    <div className="grid max-w-[980px] gap-6 md:grid-cols-[1fr_340px]">
      <Section title="Invite a vendor">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="label">Vendor name</span>
            <input className="field" value={f.vendor_name} onChange={(e) => setF({ ...f, vendor_name: e.target.value })} placeholder="e.g. Kaveri Packaging" />
          </label>
          <label className="sm:col-span-2">
            <span className="label">Vendor contact email</span>
            <input className="field" type="email" value={f.vendor_email} onChange={(e) => setF({ ...f, vendor_email: e.target.value })} placeholder="accounts@vendor.example" />
          </label>
          <label>
            <span className="label">What will you buy?</span>
            <select className="field" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Expected spend per year (₹)</span>
            <input className="field id" inputMode="numeric" value={f.spend} onChange={(e) => setF({ ...f, spend: e.target.value })} />
            <span className="mt-1 block text-[13px] text-ink-3">{inr(spend)}</span>
          </label>
          <label className="flex items-start gap-2 sm:col-span-2">
            <input type="checkbox" className="mt-1" checked={f.data_access} onChange={(e) => setF({ ...f, data_access: e.target.checked })} />
            <span>
              This vendor will get access to our data or systems
              <span className="block text-[13px] text-ink-3">e.g. software, analytics, IT support, payroll</span>
            </span>
          </label>
        </div>
        <div className="mt-6 flex justify-end">
          <button className="btn" disabled={!ok} onClick={send}>
            Send invite
          </button>
        </div>
      </Section>

      <Section title="How much checking" aside={<TierTag tier={tier} />}>
        <p className="text-[14px] text-ink-2">{why}.</p>
        <p className="mt-4 text-[14px] font-semibold">The vendor will be asked for</p>
        <ul className="mt-1 list-disc pl-5 text-[14px]">
          {docs.map((d) => (
            <li key={d}>{DOC_LABEL[d]}</li>
          ))}
        </ul>
        <p className="mt-4 text-[14px] font-semibold">Approval</p>
        <p className="text-[14px] text-ink-2">
          {tier === "STRATEGIC" ? "A person always signs off, even when every check passes." : "Automatic when every check passes. Anything unclear goes to a reviewer."}
        </p>
      </Section>
    </div>
  );
}
