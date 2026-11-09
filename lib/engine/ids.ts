// Validators for Indian and international business identifiers. Pure functions, no I/O.

const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const GST_STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};

export const clean = (s: string | undefined | null) => (s ?? "").toUpperCase().replace(/[\s-]/g, "");

/** GSTIN = 2-digit state code + 10-char PAN + entity number + 'Z' + check character. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function gstinCheckChar(first14: string): string {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const product = B36.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return B36[(36 - (total % 36)) % 36];
}

export type GstinCheck =
  | { valid: true; stateCode: string; state: string; pan: string }
  | { valid: false; reason: "format" | "checksum" | "state_code"; expectedCheck?: string };

export function validateGstin(raw: string | undefined): GstinCheck {
  const g = clean(raw);
  if (!GSTIN_RE.test(g)) return { valid: false, reason: "format" };
  const state = GST_STATE_CODES[g.slice(0, 2)];
  if (!state) return { valid: false, reason: "state_code" };
  const expected = gstinCheckChar(g.slice(0, 14));
  if (expected !== g[14]) return { valid: false, reason: "checksum", expectedCheck: expected };
  return { valid: true, stateCode: g.slice(0, 2), state, pan: g.slice(2, 12) };
}

/** PAN = 5 letters + 4 digits + 1 letter. 4th letter encodes the holder type. */
export const PAN_RE = /^[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]$/;

export const PAN_HOLDER_TYPE: Record<string, string> = {
  C: "Company", P: "Individual", F: "Firm / LLP", H: "HUF", A: "Association of Persons",
  T: "Trust", B: "Body of Individuals", L: "Local Authority", J: "Artificial Juridical Person", G: "Government",
};

/** Which PAN 4th-letter(s) are consistent with the declared constitution. */
export function expectedPanTypes(constitution: string): string[] | null {
  const c = constitution.toLowerCase();
  if (c.includes("proprietor")) return ["P"];
  if (c.includes("limited liability partnership") || c.includes("llp") || c.includes("partnership")) return ["F"];
  if (c.includes("company") || c.includes("limited")) return ["C"];
  if (c.includes("trust")) return ["T"];
  if (c.includes("huf")) return ["H"];
  return null;
}

export function validatePan(raw: string | undefined) {
  const p = clean(raw);
  if (!PAN_RE.test(p)) return { valid: false as const };
  return { valid: true as const, holderType: p[3], holderLabel: PAN_HOLDER_TYPE[p[3]] ?? "Unknown" };
}

/** IFSC = 4-letter bank code + '0' + 6-character branch code. */
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const ACCOUNT_RE = /^[0-9]{9,18}$/;

/** CIN = L/U + 5-digit industry + 2-letter state + year + 3-letter type + 6 digits. */
export const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;

// ---------------------------------------------------------------------------
// International tax IDs (format-level). Catches "tax ID format wrong for the country".
// ---------------------------------------------------------------------------
export function validateTaxIdForCountry(country: string, raw: string | undefined): { valid: boolean; expected: string } {
  const v = clean(raw);
  switch (country) {
    case "IN":
      return { valid: validateGstin(v).valid, expected: "GSTIN, e.g. 29ABCDE1234F1Z5" };
    case "US":
      // EIN: 9 digits (usually written 12-3456789)
      return { valid: /^[0-9]{9}$/.test(v), expected: "EIN, 9 digits, e.g. 12-3456789" };
    case "GB":
      return { valid: /^(GB)?([0-9]{9}|[0-9]{12})$/.test(v) && ukVatChecksum(v), expected: "VAT number, e.g. GB123456789" };
    default:
      return { valid: v.length >= 5, expected: "a valid tax registration number" };
  }
}

/** UK VAT mod-97 check (also accepts the post-2010 "mod 9755" variant). */
function ukVatChecksum(v: string) {
  const d = v.replace(/^GB/, "").slice(0, 9);
  if (d.length !== 9) return false;
  const weights = [8, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((s, w, i) => s + w * Number(d[i]), 0);
  const check = Number(d.slice(7));
  return (sum + check) % 97 === 0 || (sum + check + 55) % 97 === 0;
}

/** IBAN mod-97 (ISO 13616). For international bank accounts. */
export function validateIban(raw: string) {
  const v = clean(raw);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(v)) return false;
  const moved = v.slice(4) + v.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

/** US ABA routing number checksum (3-7-1 weights). */
export function validateAbaRouting(raw: string) {
  const v = clean(raw);
  if (!/^[0-9]{9}$/.test(v)) return false;
  const d = v.split("").map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}
