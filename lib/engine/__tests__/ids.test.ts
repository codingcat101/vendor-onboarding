import { describe, expect, it } from "vitest";
import { gstinCheckChar, validateAbaRouting, validateGstin, validateIban, validatePan, validateTaxIdForCountry } from "../ids";
import { lookupIfsc } from "../ifsc";
import { compareNames, normaliseName } from "../names";

describe("GSTIN", () => {
  it("accepts published sample GSTINs (real check digit)", () => {
    expect(validateGstin("27AAPFU0939F1ZV").valid).toBe(true);
    expect(validateGstin("33GSPTN0231G1ZM").valid).toBe(true);
  });
  it("catches a one-character typo via the check digit", () => {
    const r = validateGstin("27AAPFU0939F1ZW");
    expect(r).toMatchObject({ valid: false, reason: "checksum", expectedCheck: "V" });
  });
  it("rejects bad format and bad state code", () => {
    expect(validateGstin("27AAPFU0939F1Z").valid).toBe(false);
    expect(validateGstin("99AAPFU0939F1Z" + gstinCheckChar("99AAPFU0939F1Z"))).toMatchObject({ reason: "state_code" });
  });
  it("exposes the PAN and state inside", () => {
    expect(validateGstin("27AAPFU0939F1ZV")).toMatchObject({ pan: "AAPFU0939F", state: "Maharashtra" });
  });
});

describe("PAN / IFSC / international", () => {
  it("validates PAN and reads holder type", () => {
    expect(validatePan("AAJCK4821M")).toMatchObject({ valid: true, holderType: "C" });
    expect(validatePan("AAJXK4821M").valid).toBe(false);
  });
  it("finds real IFSC branches offline and rejects unknown ones", () => {
    expect(lookupIfsc("HDFC0000062")).toMatchObject({ found: true, bankName: "HDFC Bank" });
    expect(lookupIfsc("HDFC0987654")).toMatchObject({ found: false, reason: "unknown_branch" });
    expect(lookupIfsc("ZZZZ0000001")).toMatchObject({ found: false, reason: "unknown_bank" });
    expect(lookupIfsc("HDFC000006")).toMatchObject({ found: false, reason: "format" });
  });
  it("flags a tax ID in the wrong country's format", () => {
    expect(validateTaxIdForCountry("US", "12-3456789").valid).toBe(true);
    expect(validateTaxIdForCountry("US", "27AAPFU0939F1ZV").valid).toBe(false);
    expect(validateTaxIdForCountry("GB", "GB980780684").valid).toBe(true);
    expect(validateTaxIdForCountry("GB", "GB980780685").valid).toBe(false);
  });
  it("checks IBAN and US routing checksums", () => {
    expect(validateIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(validateIban("GB82 WEST 1234 5698 7654 33")).toBe(false);
    expect(validateAbaRouting("021000021")).toBe(true);
    expect(validateAbaRouting("021000022")).toBe(false);
  });
});

describe("Name matching", () => {
  it("normalises common abbreviations", () => {
    expect(normaliseName("M/s. Apex Facility Services Pvt. Ltd.")).toBe("APEX FACILITY SERVICES PRIVATE LIMITED");
  });
  it("treats near names as near, unrelated as mismatch", () => {
    expect(compareNames("SHARMA TRADERS", "Sharma Trading Co.").verdict).toBe("near");
    expect(compareNames("Orion Engineering Works Pvt Ltd", "Deccan Engineering Private Limited").verdict).toBe("mismatch");
  });
  it("a taught equivalence resolves a near match", () => {
    const eqs = [{ phrases: ["TRADERS", "TRADING COMPANY"], constitutions: ["proprietor"] }];
    expect(compareNames("SHARMA TRADERS", "Sharma Trading Co.", eqs, "Proprietorship")).toMatchObject({ verdict: "match", ruleApplied: true });
    // scoped: does not apply to a company
    expect(compareNames("SHARMA TRADERS", "Sharma Trading Co.", eqs, "Private Limited Company").verdict).toBe("near");
  });
  it("GUARDRAIL: a taught rule can never turn a clear mismatch into a match", () => {
    const evil = [{ phrases: ["ACME HOLDINGS", "SHARMA TRADING COMPANY"] }];
    expect(compareNames("ACME HOLDINGS", "Sharma Trading Co.", evil).verdict).toBe("mismatch");
  });
});
