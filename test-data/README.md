# Test data — vendor onboarding

All companies, people, PANs, GSTINs and account numbers are **fictional**. Every document carries a SPECIMEN watermark.
GSTINs carry a valid check digit (official base-36 algorithm), so they pass format checks and the logic has to work harder.
IFSC codes are real bank branch codes (validated against Razorpay's open IFSC dataset, MIT licence, in `data/ifsc/`).

Regenerate with `python3 scripts/generate_test_data.py` (seeded, so output is stable).

## Scenarios

| ID | Tier | What's going on | Expected first decision | What happens next |
|---|---|---|---|---|
| V01 | Standard | Kaveri Packaging — clean submission, all docs match | **Approved** | — |
| V02 | Strategic | Nimbus Cloud Analytics — clean, but gets data access and ₹2.4Cr spend | **Pending (internal)** — sign-off required | Reviewer signs off → Approved |
| V03 | Low | Ganga Office Supplies — uploaded an **invoice** in the GST certificate slot | **Pending (vendor)** — wrong document | Vendor uploads `fix/gst_certificate.pdf` → only doc + cross-checks re-run → Approved |
| V04 | Low | Sharma Trading Co. (proprietor) — bank account is in **"Sharma Traders"** | **Pending (internal)** — name near-match | Reviewer approves and *teaches* the rule → policy v2 |
| V05 | Low | Gupta Trading Company — bank account **"Gupta Traders"**; cheque is a **phone photo** | Pending (internal) under v1 | Under policy v2 → **Approved automatically** |
| V06 | Standard | Apex Facility Services — bank account **already belongs to Velocity Logistics** (VM-0001) | **Rejected** — shared bank account | Reviewer tries to teach an exception → **blocked by guardrail** |
| V07 | Standard | Orion Engineering (Coimbatore, TN) — GSTIN is valid but **belongs to Deccan Engineering** (VM-0002): different PAN, Maharashtra state code, uploaded certificate shows Deccan | **Rejected** — identity mismatch | — |
| V09 | Low | Thames Precision Tools (UK) — enters its Indian subsidiary's **GSTIN as its UK tax ID**; bank letter instead of a cheque, valid IBAN | **Pending (vendor)** — tax ID format wrong for the country | Vendor enters a UK VAT number → only 2 of 9 checks re-run → Approved |
| V10 | Strategic | Lumen Payroll Services — gets payroll **data access**; ISO 27001 certificate **expired** on 30 Sep 2026 | **Pending (vendor)** — certificate expired | Vendor uploads `fix/security_certificate.pdf` (valid to 2029) → only certificate checks re-run → Pending (internal) for strategic sign-off |
| V11 | Standard | Brightwater Industrial Supply LLC (Ohio, US) — **W-9** + ACH bank letter; EIN, name and routing number (ABA checksum) all agree | **Approved** | — |
| V12 | Standard | Harborline Logistics Inc. (Georgia, US) — W-9 is in its own name, but the **bank letter is for "Coastal Ledger Holdings LLC"** | **Rejected** — bank account in another name (payment-redirection pattern) | Guardrail: can't be taught or overridden |
| V13 | Low | Sabel Ridge Trading LLC (Arizona, US) — name is 99% similar to **"Sable Ridge Trading Co"** on the specimen sanctions watchlist | **Pending (internal)** — possible watchlist match | A named reviewer compares the details and clears it with a reason; no rule can ever clear it |
| V08 | Standard | Lotus Print House — **cancelled cheque missing**; PAN card is an image-only scan | **Pending (vendor)** — missing document | Vendor goes silent → day 2 reminder → day 5 escalate to buyer → day 10 expired (fix file available if you want to show recovery instead) |

## Files

- `scenarios/<ID>/invite.json` — what the buyer entered (category, annual spend, data access → decides the tier)
- `scenarios/<ID>/submission.json` — what the vendor typed into the form, plus which file went into which upload slot
- `scenarios/<ID>/docs/` — uploaded documents · `fix/` — documents sent later to resolve an issue
- `expected.json` — expected tier, status, reason codes, and the **ground-truth fields of every document** (used to measure extraction accuracy)
- `../data/vendor_master.json` — 20 vendors already on file (for duplicate bank account / GSTIN checks)
- `../data/watchlist.json` — a **fictional specimen** sanctions watchlist (6 made-up entries) standing in for the OFAC SDN / Consolidated Screening lists

## Tier rules used

| Tier | Trigger | Required documents | Approval |
|---|---|---|---|
| Low | annual spend < ₹5L and no data/system access | GST certificate, cancelled cheque | Auto if all checks pass |
| Standard | ₹5L – ₹1Cr | + PAN card | Auto if all checks pass |
| Strategic | > ₹1Cr **or** data/system access | + Certificate of incorporation (+ ISO 27001 / SOC 2 if data access) | Human sign-off always |

Outside India the GST certificate and PAN card are not asked for; a bank letter is accepted for the cheque. **US vendors** always add an IRS **Form W-9** (legal name, EIN, signature), checked against the form.
