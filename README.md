# Vendor Onboarding

A vendor onboarding process for Indian procurement teams. It checks what a vendor submits, sends back anything the vendor can fix, asks a person about anything unclear, and learns from the reviewers' decisions.

Built for the Zamp AI Solutions Analyst case study (problem statement 2).

## The idea in one line

**AI reads the documents; plain code makes every decision.** The AI only ever sees the document, never what the vendor typed, so it reports what is printed rather than confirming the form. Every approve / return / review / reject comes from rules you can read and audit.

## What it does

| | |
|---|---|
| **Risk-based checking** | The buyer enters category, expected spend and whether the vendor gets data access. That sets the tier: Low (< ₹5L), Standard (₹5L–1Cr) or Strategic (> ₹1Cr or data access). The tier decides which documents are needed and whether a person must sign off. |
| **Checks** | Tax ID format for the vendor's country (India GSTIN, UK VAT, US EIN; UK IBAN and US routing checksums) · Required fields and documents · document is the right type and readable · GSTIN check digit · PAN format and holder type vs. business type · IFSC is a real branch (offline registry of 176,918 branches) · PAN inside GSTIN = PAN given · GSTIN state = address state · documents match the form · bank account holder is the vendor · bank account, GSTIN and PAN not already used by another vendor |
| **Decision** | **Approved**, **Pending** or **Rejected**, with every reason visible. Any integrity problem → Rejected. Anything the vendor can fix → Pending: vendor. Anything unclear → Pending: review. Otherwise Approved (Strategic vendors always need a sign-off). |
| **Fix loop** | The vendor gets a page listing only what to fix. On resubmission only the affected checks run again; the rest are kept and marked as such. |
| **AI unavailable** | If no model can read a document (outage, quota), it goes to a person; the vendor is never blamed and nothing is treated as a mismatch. |
| **Guardrails** | Fraud signals (shared bank account, someone else's GSTIN, name mismatch on documents) can never be relaxed by a taught rule. A taught name rule can only settle near-matches, never make an unrelated name count. A field the AI could not read is sent to a person, never treated as a mismatch. |

## AI reading accuracy

Measured on the 23 sample documents (including a tilted phone photo of a cheque and an image-only scan of a PAN card) against hand-recorded correct values. `npx tsx scripts/eval-readings.ts`

| Document type identified | Fields read correctly | Average time |
|---|---|---|
| 23 / 23 (100%) | 75 / 76 (98.7%) | 6.5 s per document |

The one miss was a blank name on a PAN card. That case is handled safely: the PAN still matched, and the unread name is flagged instead of being treated as a mismatch.

Models are tried in order (`gemini-3.6-flash`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite`), each with a 25-second limit. If none answers, the sample documents fall back to the AI reading recorded during this evaluation, and the screen says so.

## Sample vendors

See [test-data/README.md](test-data/README.md). All companies, people and identifiers are fictional; every document is marked SPECIMEN.

## Run it

```bash
npm install
echo "GEMINI_API_KEY=your-key" > .env.local
npm run dev            # http://localhost:3000
npm test               # 48 tests: identifiers, every scenario, fix loop, teaching, guardrails, real AI readings
```

Each visitor gets a private sandbox kept in their browser ("Reset demo" clears it), so several people can try the live link at once without affecting each other.

## Layout

```
lib/engine/        checks, decision, policy, name matching, identifier validators, AI reader (server)
lib/client/        browser sandbox store and submission pipeline
app/               pages: cases, invite, vendor form, case file; API routes: read, run, scenarios, file
test-data/         8 sample vendors, documents, expected outcomes, recorded AI readings
data/              existing vendor master, IFSC registry (Razorpay, MIT licence)
scripts/           test-data generator, AI accuracy evaluation
```
