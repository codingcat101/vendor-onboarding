"""
Generates fictional test data for the vendor onboarding process.

Outputs (under test-data/ and data/):
  - scenarios/<ID>/submission.json   what the vendor typed into the form
  - scenarios/<ID>/invite.json       what the buyer entered when inviting the vendor
  - scenarios/<ID>/docs/*            documents the vendor uploaded (PDF / JPG)
  - scenarios/<ID>/fix/*             documents the vendor sends later to fix an issue
  - expected.json                    expected decision + ground-truth document fields
  - data/vendor_master.json          vendors already on file (for duplicate / fraud checks)

Every company, person, address, PAN, GSTIN and account number here is invented.
All documents carry a SPECIMEN watermark. Run:  python3 scripts/generate_test_data.py
"""
import io
import json
import random
import shutil
from pathlib import Path

import fitz  # PyMuPDF, used only to rasterise pages for the "scanned" variants
from PIL import Image, ImageFilter, ImageEnhance
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test-data"
SCEN = OUT / "scenarios"
random.seed(42)

# ----------------------------------------------------------------------------
# Indian identifiers
# ----------------------------------------------------------------------------
B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_check_char(first14: str) -> str:
    """Official GSTIN check-digit algorithm (base-36, alternating weights 1/2)."""
    total = 0
    for i, ch in enumerate(first14):
        product = B36.index(ch) * (1 if i % 2 == 0 else 2)
        total += product // 36 + product % 36
    return B36[(36 - total % 36) % 36]


def make_gstin(state_code: str, pan: str, entity_no: str = "1") -> str:
    body = f"{state_code}{pan}{entity_no}Z"
    return body + gstin_check_char(body)


def random_pan(entity_type: str, name_initial: str) -> str:
    letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    return (
        "".join(random.choice(letters) for _ in range(3))
        + entity_type
        + name_initial.upper()
        + f"{random.randint(1000, 9999)}"
        + random.choice(letters)
    )


STATES = {
    "07": "Delhi", "09": "Uttar Pradesh", "19": "West Bengal", "24": "Gujarat",
    "27": "Maharashtra", "29": "Karnataka", "33": "Tamil Nadu", "36": "Telangana",
}
BANKS = {"HDFC": "HDFC Bank", "ICIC": "ICICI Bank", "SBIN": "State Bank of India",
         "UTIB": "Axis Bank", "KKBK": "Kotak Mahindra Bank", "CNRB": "Canara Bank",
         "PUNB": "Punjab National Bank"}
ACC_LEN = {"HDFC": 14, "ICIC": 12, "SBIN": 11, "UTIB": 15, "KKBK": 10, "CNRB": 13, "PUNB": 16}


def acc_no(bank: str) -> str:
    n = ACC_LEN[bank]
    return str(random.randint(1, 9)) + "".join(str(random.randint(0, 9)) for _ in range(n - 1))


# ----------------------------------------------------------------------------
# Scenarios
# ----------------------------------------------------------------------------
def company(legal, trade, constitution, state, city, street, pincode, pan, gstin,
            contact, email, phone, bank, ifsc, acc, holder, **extra):
    return dict(legal_name=legal, trade_name=trade, constitution=constitution, country="IN",
                address=dict(line1=street, city=city, state=STATES[state], pincode=pincode),
                gstin=gstin, pan=pan,
                contact=dict(name=contact, email=email, phone=phone),
                bank=dict(account_holder=holder, account_number=acc, ifsc=ifsc, bank_name=BANKS[ifsc[:4]]),
                **extra)


# Vendor master (existing approved vendors). Two of them are "victims" in fraud scenarios.
velocity_acc = acc_no("UTIB")
deccan_pan = "AAHCD7781F"
deccan_gstin = make_gstin("27", deccan_pan)

S = {}

pan = "AAJCK4821M"
S["V01"] = dict(
    title="Happy path — Standard tier, everything checks out",
    invite=dict(buyer="Priya Nair (Procurement)", category="Packaging materials",
                annual_spend_inr=4_000_000, data_access=False),
    form=company("Kaveri Packaging Solutions Private Limited", "Kaveri Packaging",
                 "Private Limited Company", "29", "Bengaluru", "No. 14, 3rd Cross, Peenya Industrial Area",
                 "560058", pan, make_gstin("29", pan), "Anil Kumar R", "accounts@kaveripack.example",
                 "+91 98450 11223", "HDFC", "HDFC0000062", acc_no("HDFC"),
                 "KAVERI PACKAGING SOLUTIONS PRIVATE LIMITED"),
    docs={"gst_certificate": "gst", "pan_card": "pan", "cancelled_cheque": "cheque"},
    expected=dict(tier="STANDARD", status="APPROVED", reasons=[]),
)

pan = "AAGCN7314Q"
S["V02"] = dict(
    title="Happy path — Strategic tier: passes all checks, still needs human sign-off",
    invite=dict(buyer="Priya Nair (Procurement)", category="IT services / data analytics",
                annual_spend_inr=24_000_000, data_access=True),
    form=company("Nimbus Cloud Analytics Private Limited", "Nimbus Analytics",
                 "Private Limited Company", "27", "Pune", "Office 602, Tower B, Baner Road",
                 "411045", pan, make_gstin("27", pan), "Meera Joshi", "finance@nimbusanalytics.example",
                 "+91 98220 44567", "ICIC", "ICIC0000039", acc_no("ICIC"),
                 "NIMBUS CLOUD ANALYTICS PRIVATE LIMITED",
                 cin="U72900MH2019PTC324517"),
    docs={"gst_certificate": "gst", "pan_card": "pan", "cancelled_cheque": "cheque",
          "incorporation_certificate": "coi"},
    expected=dict(tier="STRATEGIC", status="PENDING_INTERNAL", reasons=["STRATEGIC_SIGNOFF_REQUIRED"]),
)

pan = "AAKFG2290B"
S["V03"] = dict(
    title="Edge 1 — Wrong document: an invoice uploaded in the GST certificate slot",
    invite=dict(buyer="Rahul Verma (Admin)", category="Office stationery",
                annual_spend_inr=300_000, data_access=False),
    form=company("Ganga Office Supplies LLP", "Ganga Office Supplies", "Limited Liability Partnership",
                 "09", "Lucknow", "22/7 Hazratganj Market Road", "226001", pan, make_gstin("09", pan),
                 "Sunil Mishra", "sunil@gangaoffice.example", "+91 94150 77881", "SBIN",
                 "SBIN0001520", acc_no("SBIN"), "GANGA OFFICE SUPPLIES LLP"),
    docs={"gst_certificate": "invoice", "cancelled_cheque": "cheque"},
    fix={"gst_certificate": "gst"},
    expected=dict(tier="LOW", status="PENDING_VENDOR", reasons=["DOC_WRONG_TYPE"],
                  after_fix=dict(status="APPROVED", rechecked=["document_check", "cross_reference"])),
)

pan = "BQRPS6127K"
S["V04"] = dict(
    title="Edge 2a — Proprietorship: bank account in 'Sharma Traders', trade name 'Sharma Trading Co.'",
    invite=dict(buyer="Rahul Verma (Admin)", category="Electrical supplies",
                annual_spend_inr=400_000, data_access=False),
    form=company("Rakesh Sharma", "Sharma Trading Co.", "Proprietorship", "07", "New Delhi",
                 "Shop 41, Bhagirath Palace, Chandni Chowk", "110006", pan, make_gstin("07", pan),
                 "Rakesh Sharma", "sharmatrading@mail.example", "+91 98110 32456", "PUNB",
                 "PUNB0016400", acc_no("PUNB"), "SHARMA TRADERS"),
    docs={"gst_certificate": "gst", "cancelled_cheque": "cheque"},
    expected=dict(tier="LOW", status="PENDING_INTERNAL", reasons=["BANK_NAME_NEAR_MATCH"],
                  teach="For proprietorships, 'Traders' and 'Trading Co./Company' are the same business name"),
)

pan = "CHNPG4410L"
S["V05"] = dict(
    title="Edge 2b — Same pattern ('Gupta Traders' vs 'Gupta Trading Company'); cheque is a phone photo",
    invite=dict(buyer="Rahul Verma (Admin)", category="Hardware & tools",
                annual_spend_inr=250_000, data_access=False),
    form=company("Neha Gupta", "Gupta Trading Company", "Proprietorship", "24", "Ahmedabad",
                 "12 Relief Road, Near Kalupur Gate", "380001", pan, make_gstin("24", pan),
                 "Neha Gupta", "guptatrading@mail.example", "+91 97250 61234", "KKBK",
                 "KKBK0000182", acc_no("KKBK"), "GUPTA TRADERS"),
    docs={"gst_certificate": "gst", "cancelled_cheque": "cheque@photo"},
    expected=dict(tier="LOW", status="PENDING_INTERNAL", reasons=["BANK_NAME_NEAR_MATCH"],
                  after_rule=dict(status="APPROVED")),
)

pan = "AADCA5530R"
S["V06"] = dict(
    title="Edge 3a — Bank account already belongs to another vendor on file",
    invite=dict(buyer="Priya Nair (Procurement)", category="Housekeeping services",
                annual_spend_inr=1_200_000, data_access=False),
    form=company("Apex Facility Services Private Limited", "Apex Facility Services",
                 "Private Limited Company", "33", "Chennai", "No. 8, 2nd Main Road, Guindy Industrial Estate",
                 "600032", pan, make_gstin("33", pan), "Karthik S", "billing@apexfacility.example",
                 "+91 94440 98712", "UTIB", "UTIB0000017", velocity_acc,
                 "APEX FACILITY SERVICES PVT LTD"),
    docs={"gst_certificate": "gst", "pan_card": "pan", "cancelled_cheque": "cheque"},
    expected=dict(tier="STANDARD", status="REJECTED", reasons=["BANK_ACCOUNT_SHARED"],
                  guardrail="A taught rule cannot allow shared bank accounts"),
)

pan = "AAKCO3302H"
S["V07"] = dict(
    title="Edge 3b — GSTIN is valid but belongs to someone else (other PAN, other state)",
    invite=dict(buyer="Priya Nair (Procurement)", category="Machined components",
                annual_spend_inr=6_000_000, data_access=False),
    form=company("Orion Engineering Works Private Limited", "Orion Engineering",
                 "Private Limited Company", "33", "Coimbatore", "SF 112, Avinashi Road, Peelamedu",
                 "641004", pan, deccan_gstin, "Vignesh R", "accounts@orioneng.example",
                 "+91 99440 23419", "CNRB", "CNRB0000418", acc_no("CNRB"),
                 "ORION ENGINEERING WORKS PRIVATE LIMITED"),
    # The GST certificate the vendor uploads is Deccan Engineering's (the real GSTIN owner).
    docs={"gst_certificate": "gst@deccan", "pan_card": "pan", "cancelled_cheque": "cheque"},
    expected=dict(tier="STANDARD", status="REJECTED",
                  reasons=["GSTIN_PAN_MISMATCH", "GSTIN_STATE_MISMATCH", "GSTIN_BELONGS_TO_OTHER_VENDOR",
                           "DOC_NAME_MISMATCH"]),
)

pan = "AAJFL6618D"
S["V08"] = dict(
    title="Edge 4 — Cancelled cheque missing; vendor goes silent (reminder → escalation → expiry)",
    invite=dict(buyer="Rahul Verma (Admin)", category="Printing & signage",
                annual_spend_inr=800_000, data_access=False),
    form=company("Lotus Print House", "Lotus Print House", "Partnership Firm", "19", "Kolkata",
                 "5 Lalbazar Street, 2nd Floor", "700001", pan, make_gstin("19", pan),
                 "Debashis Roy", "lotusprint@mail.example", "+91 98300 55120", "SBIN",
                 "SBIN0000691", acc_no("SBIN"), "LOTUS PRINT HOUSE"),
    docs={"gst_certificate": "gst", "pan_card": "pan@scan"},
    fix={"cancelled_cheque": "cheque"},
    expected=dict(tier="STANDARD", status="PENDING_VENDOR", reasons=["DOC_MISSING"],
                  timeline={"day_2": "REMINDER", "day_5": "ESCALATED_TO_BUYER", "day_10": "EXPIRED"}),
)

# ----------------------------------------------------------------------------
# Vendor master
# ----------------------------------------------------------------------------
MASTER_NAMES = [
    ("Velocity Logistics Private Limited", "C", "33", "UTIB"),
    ("Deccan Engineering Private Limited", "C", "27", "HDFC"),
    ("Sahyadri Foods Private Limited", "C", "27", "ICIC"),
    ("Bluewave IT Services Private Limited", "C", "29", "HDFC"),
    ("Mehta Chemicals", "F", "24", "SBIN"),
    ("Coromandel Textiles Private Limited", "C", "33", "CNRB"),
    ("Arora Electricals", "P", "07", "PUNB"),
    ("Brightline Security Services LLP", "F", "36", "KKBK"),
    ("Konark Furniture Works", "F", "19", "SBIN"),
    ("Greenleaf Facility Management Private Limited", "C", "29", "UTIB"),
    ("Indus Courier Services Private Limited", "C", "07", "ICIC"),
    ("Narmada Paper Mills Limited", "C", "24", "HDFC"),
    ("Pinnacle Event Solutions LLP", "F", "27", "KKBK"),
    ("Saraswati Printers", "P", "09", "SBIN"),
    ("Techvista Software Private Limited", "C", "36", "HDFC"),
    ("Hooghly Steel Traders", "F", "19", "PUNB"),
    ("Malabar Spices Exports Private Limited", "C", "33", "CNRB"),
    ("Royal Catering Services", "P", "07", "SBIN"),
    ("Everest Power Systems Private Limited", "C", "29", "ICIC"),
    ("Unity Medical Supplies LLP", "F", "24", "UTIB"),
]
IFSC_POOL = {"UTIB": ["UTIB0000565", "UTIB0000072"], "HDFC": ["HDFC0001234", "HDFC0000240"],
             "ICIC": ["ICIC0001052", "ICIC0000104"], "SBIN": ["SBIN0005943", "SBIN0000001"],
             "CNRB": ["CNRB0000418"], "PUNB": ["PUNB0016400"], "KKBK": ["KKBK0000958"]}

master = []
for i, (name, etype, st, bank) in enumerate(MASTER_NAMES, start=1):
    if name.startswith("Deccan"):
        p, g = deccan_pan, deccan_gstin
    else:
        p = random_pan(etype, name.split()[0][0] if etype != "P" else name.split()[0][0])
        g = make_gstin(st, p)
    acc = velocity_acc if name.startswith("Velocity") else acc_no(bank)
    master.append(dict(
        vendor_id=f"VM-{i:04d}", legal_name=name, gstin=g, pan=p, state=STATES[st],
        bank=dict(account_number=acc, ifsc=random.choice(IFSC_POOL[bank]), bank_name=BANKS[bank]),
        status="ACTIVE", onboarded_on=f"20{random.randint(22, 25)}-{random.randint(1, 12):02d}-{random.randint(1, 28):02d}",
    ))

# ----------------------------------------------------------------------------
# V09: an international vendor (added after the master so the Indian data stays identical)
# ----------------------------------------------------------------------------
rng = random.Random(909)


def uk_vat() -> str:
    while True:
        d = [rng.randint(0, 9) for _ in range(7)]
        total = sum(w * x for w, x in zip([8, 7, 6, 5, 4, 3, 2], d))
        check = (97 - total % 97) % 97
        if check < 97:
            return "GB" + "".join(map(str, d)) + f"{check:02d}"


def uk_iban(bank: str, sort: str, acc: str) -> str:
    bban = bank + sort + acc
    num = "".join(str(int(ch, 36)) for ch in bban + "GB00")
    check = 98 - int(num) % 97
    return f"GB{check:02d}{bban}"


v09_iban = uk_iban("TMSB", "401276", "".join(str(rng.randint(0, 9)) for _ in range(8)))
v09_bad_tax = make_gstin("27", "AAKCT" + "5507" + "Q")
S["V09"] = dict(
    title="Edge 5 — UK vendor enters an Indian GSTIN as its tax ID (format wrong for the country)",
    invite=dict(buyer="Priya Nair (Procurement)", category="Machined components",
                annual_spend_inr=400_000, data_access=False),
    form=dict(legal_name="Thames Precision Tools Limited", trade_name="Thames Precision", constitution="Private Limited Company",
              country="GB", address=dict(line1="Unit 4, Riverside Business Park, Rotherhithe", city="London", state="England",
                                         pincode="SE16 4DG"),
              tax_id=v09_bad_tax, contact=dict(name="Oliver Grant", email="accounts@thamesprecision.example", phone="+44 20 7946 0321"),
              bank=dict(account_holder="THAMES PRECISION TOOLS LIMITED", account_number=v09_iban, ifsc="", bank_name="Thamesbank (fictional)")),
    docs={"cancelled_cheque": "bankletter"},
    fix_fields={"tax_id": uk_vat()},
    expected=dict(tier="LOW", status="PENDING_VENDOR", reasons=["TAX_ID_FORMAT"], after_fix=dict(status="APPROVED")),
)

# ----------------------------------------------------------------------------
# Document rendering
# ----------------------------------------------------------------------------
W, H = A4


def watermark(c):
    c.saveState()
    c.setFillColor(colors.Color(0.85, 0.1, 0.1, alpha=0.10))
    c.setFont("Helvetica-Bold", 90)
    c.translate(W / 2, H / 2)
    c.rotate(35)
    c.drawCentredString(0, 0, "SPECIMEN")
    c.restoreState()
    c.setFont("Helvetica-Oblique", 7)
    c.setFillColor(colors.grey)
    c.drawCentredString(W / 2, 12 * mm, "Fictional specimen generated for software testing. Not a real document.")
    c.setFillColor(colors.black)


def kv_table(c, x, y, rows, label_w=62 * mm, row_h=9 * mm, width=170 * mm):
    for label, value in rows:
        c.setStrokeColor(colors.Color(0.7, 0.7, 0.7))
        c.rect(x, y - row_h, width, row_h, stroke=1, fill=0)
        c.line(x + label_w, y - row_h, x + label_w, y)
        c.setFont("Helvetica", 9)
        c.drawString(x + 2 * mm, y - row_h + 3 * mm, label)
        c.setFont("Helvetica-Bold", 9.5)
        lines = str(value).split("\n")
        if len(lines) == 1:
            c.drawString(x + label_w + 2 * mm, y - row_h + 3 * mm, lines[0])
        else:
            c.drawString(x + label_w + 2 * mm, y - row_h + 5.2 * mm, lines[0])
            c.drawString(x + label_w + 2 * mm, y - row_h + 1.5 * mm, lines[1])
        y -= row_h
    return y


def addr_str(a):
    return f"{a['line1']},\n{a['city']}, {a['state']} - {a['pincode']}"


def render_gst(c, f, gstin=None, legal=None, trade=None, constitution=None, address=None):
    gstin = gstin or f["gstin"]
    c.setFont("Helvetica-Bold", 15)
    c.drawCentredString(W / 2, H - 30 * mm, "Registration Certificate")
    c.setFont("Helvetica", 10)
    c.drawCentredString(W / 2, H - 37 * mm, "Form GST REG-06  ·  Goods and Services Tax  ·  SPECIMEN")
    c.setFont("Helvetica-Bold", 11)
    c.drawString(20 * mm, H - 52 * mm, f"Registration Number:  {gstin}")
    rows = [
        ("1. Legal Name", legal or f["legal_name"].upper()),
        ("2. Trade Name, if any", trade or f["trade_name"].upper()),
        ("3. Constitution of Business", constitution or f["constitution"]),
        ("4. Address of Principal Place of\n   Business", address or addr_str(f["address"])),
        ("5. Date of Liability", "01/04/2021"),
        ("6. Period of Validity", "From 01/04/2021  To  Not Applicable"),
        ("7. Type of Registration", "Regular"),
        ("8. Particulars of Approving Authority", "Specimen Officer, Range-IV (fictional)"),
        ("9. Date of issue of Certificate", "12/04/2021"),
    ]
    kv_table(c, 20 * mm, H - 60 * mm, [(l.replace("\n", " "), v) for l, v in rows], row_h=11 * mm)
    watermark(c)


def render_pan(c, f):
    x, y, w, h = 45 * mm, H - 120 * mm, 120 * mm, 76 * mm
    c.setFillColor(colors.Color(0.86, 0.92, 0.97))
    c.roundRect(x, y, w, h, 4 * mm, stroke=1, fill=1)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x + 6 * mm, y + h - 9 * mm, "PERMANENT ACCOUNT NUMBER CARD  (SPECIMEN)")
    is_person = f["constitution"] == "Proprietorship"
    c.setFont("Helvetica", 7.5)
    c.drawString(x + 6 * mm, y + h - 19 * mm, "Name")
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x + 6 * mm, y + h - 24 * mm, f["legal_name"].upper())
    c.setFont("Helvetica", 7.5)
    c.drawString(x + 6 * mm, y + h - 32 * mm, "Date of Birth" if is_person else "Date of Incorporation / Formation")
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x + 6 * mm, y + h - 37 * mm, "14/08/1984" if is_person else "09/07/2019")
    c.setFont("Helvetica", 7.5)
    c.drawString(x + 6 * mm, y + h - 47 * mm, "Permanent Account Number")
    c.setFont("Courier-Bold", 16)
    c.drawString(x + 6 * mm, y + h - 55 * mm, f["pan"])
    c.setStrokeColor(colors.grey)
    c.rect(x + w - 32 * mm, y + h - 52 * mm, 24 * mm, 28 * mm)
    c.setFont("Helvetica", 6)
    c.drawCentredString(x + w - 20 * mm, y + h - 38 * mm, "[photo]" if is_person else "[logo]")
    watermark(c)


def render_cheque(c, f):
    b = f["bank"]
    x, y, w, h = 15 * mm, H - 110 * mm, 180 * mm, 80 * mm
    c.setFillColor(colors.Color(0.95, 0.97, 0.93))
    c.rect(x, y, w, h, stroke=1, fill=1)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(x + 6 * mm, y + h - 10 * mm, b["bank_name"].upper())
    c.setFont("Helvetica", 8.5)
    c.drawString(x + 6 * mm, y + h - 15 * mm, f"IFSC: {b['ifsc']}")
    c.drawRightString(x + w - 6 * mm, y + h - 10 * mm, "Date  _ _ / _ _ / _ _ _ _")
    c.setFont("Helvetica", 9)
    c.drawString(x + 6 * mm, y + h - 27 * mm, "Pay ______________________________________________________  or Bearer")
    c.drawString(x + 6 * mm, y + h - 36 * mm, "Rupees ___________________________________________   ₹ [            ]".replace("₹", "Rs."))
    c.setFont("Helvetica", 8.5)
    c.drawString(x + 6 * mm, y + h - 47 * mm, "A/c No.")
    c.setFont("Courier-Bold", 12)
    c.drawString(x + 22 * mm, y + h - 47.5 * mm, b["account_number"])
    c.setFont("Helvetica-Bold", 9)
    c.drawRightString(x + w - 8 * mm, y + 20 * mm, f"For {b['account_holder']}")
    c.setFont("Helvetica", 7.5)
    c.drawRightString(x + w - 8 * mm, y + 12 * mm, "Authorised Signatory")
    c.setFont("Courier", 11)
    c.drawString(x + 30 * mm, y + 4 * mm, f"⑈{random.randint(100000, 999999)}⑈ {random.randint(100, 999)}{random.randint(100000, 999999)}⑆ {random.randint(100000, 999999)}⑈ 29".replace("⑈", '"').replace("⑆", ":"))
    # CANCELLED crossing
    c.saveState()
    c.setStrokeColor(colors.Color(0.8, 0.1, 0.1))
    c.setLineWidth(1.6)
    c.line(x + 40 * mm, y + 8 * mm, x + 130 * mm, y + h - 6 * mm)
    c.line(x + 50 * mm, y + 8 * mm, x + 140 * mm, y + h - 6 * mm)
    c.setFillColor(colors.Color(0.8, 0.1, 0.1))
    c.setFont("Helvetica-Bold", 22)
    c.translate(x + 92 * mm, y + 42 * mm)
    c.rotate(38)
    c.drawCentredString(0, 0, "CANCELLED")
    c.restoreState()
    watermark(c)


def render_coi(c, f):
    c.setFont("Helvetica-Bold", 16)
    c.drawCentredString(W / 2, H - 35 * mm, "Certificate of Incorporation")
    c.setFont("Helvetica", 10)
    c.drawCentredString(W / 2, H - 42 * mm, "[Pursuant to the Companies Act, 2013]  ·  SPECIMEN")
    c.setFont("Helvetica", 11)
    text = [
        "I hereby certify that",
        f"{f['legal_name'].upper()}",
        "is incorporated on this Ninth day of July Two thousand nineteen under the",
        "Companies Act, 2013 and that the company is limited by shares.",
        "",
        f"The Corporate Identity Number of the company is {f['cin']}.",
        f"The Permanent Account Number (PAN) of the company is {f['pan']}.",
        "",
        "Given under my hand at Manesar this Ninth day of July Two thousand nineteen.",
    ]
    y = H - 65 * mm
    for i, line in enumerate(text):
        c.setFont("Helvetica-Bold" if i == 1 else "Helvetica", 12 if i == 1 else 10.5)
        c.drawCentredString(W / 2, y, line)
        y -= 9 * mm
    c.setFont("Helvetica", 9)
    c.drawString(120 * mm, y - 20 * mm, "Specimen Registrar (fictional)")
    c.drawString(120 * mm, y - 25 * mm, "Central Registration Centre")
    watermark(c)


def render_invoice(c, f):
    c.setFont("Helvetica-Bold", 18)
    c.drawString(20 * mm, H - 30 * mm, "TAX INVOICE")
    c.setFont("Helvetica-Bold", 11)
    c.drawString(20 * mm, H - 42 * mm, f["legal_name"])
    c.setFont("Helvetica", 9)
    a = f["address"]
    c.drawString(20 * mm, H - 48 * mm, f"{a['line1']}, {a['city']}, {a['state']} - {a['pincode']}")
    c.drawString(20 * mm, H - 53 * mm, f"GSTIN: {f['gstin']}")
    c.drawRightString(190 * mm, H - 42 * mm, "Invoice No: GOS/24-25/0187")
    c.drawRightString(190 * mm, H - 48 * mm, "Date: 18/10/2026")
    c.setFont("Helvetica-Bold", 9)
    c.drawString(20 * mm, H - 66 * mm, "Bill To: Northwind Retail Private Limited (fictional), Noida")
    y = H - 80 * mm
    rows = [("Description", "HSN", "Qty", "Rate", "Amount"),
            ("A4 copier paper, 75 GSM (box of 5 reams)", "4802", "20", "1,450.00", "29,000.00"),
            ("Ball pens, blue (pack of 50)", "9608", "15", "320.00", "4,800.00"),
            ("Box files, foolscap", "4820", "40", "95.00", "3,800.00")]
    xs = [20, 110, 130, 145, 168]
    for r_i, r in enumerate(rows):
        c.setFont("Helvetica-Bold" if r_i == 0 else "Helvetica", 9)
        for xi, val in zip(xs, r):
            c.drawString(xi * mm, y, val)
        y -= 8 * mm
    c.line(20 * mm, y + 4 * mm, 190 * mm, y + 4 * mm)
    for label, val in [("Taxable value", "37,600.00"), ("CGST 9%", "3,384.00"), ("SGST 9%", "3,384.00"),
                       ("Total", "44,368.00")]:
        c.setFont("Helvetica-Bold" if label == "Total" else "Helvetica", 9.5)
        c.drawString(140 * mm, y - 2 * mm, label)
        c.drawRightString(190 * mm, y - 2 * mm, val)
        y -= 7 * mm
    watermark(c)


def render_bankletter(c, f):
    b = f["bank"]
    c.setFont("Helvetica-Bold", 16)
    c.drawString(20 * mm, H - 28 * mm, "THAMESBANK  (fictional bank)")
    c.setFont("Helvetica", 9)
    c.drawString(20 * mm, H - 34 * mm, "1 Specimen Square, London EC2A 4XX  ·  SPECIMEN")
    c.setFont("Helvetica", 10)
    c.drawString(20 * mm, H - 50 * mm, "12 October 2026")
    c.drawString(20 * mm, H - 62 * mm, "To whom it may concern")
    c.setFont("Helvetica-Bold", 11)
    c.drawString(20 * mm, H - 74 * mm, "Confirmation of bank account details")
    c.setFont("Helvetica", 10)
    c.drawString(20 * mm, H - 84 * mm, "We confirm that the following account is held with us and is in good standing.")
    iban = b["account_number"]
    rows = [("Account name", b["account_holder"]), ("Sort code", f"{iban[8:10]}-{iban[10:12]}-{iban[12:14]}"),
            ("Account number", iban[14:]), ("IBAN", " ".join(iban[i:i + 4] for i in range(0, len(iban), 4))), ("BIC", "TMSBGB2L")]
    kv_table(c, 20 * mm, H - 92 * mm, rows, label_w=45 * mm, width=150 * mm)
    c.drawString(20 * mm, H - 150 * mm, "Yours faithfully,")
    c.drawString(20 * mm, H - 165 * mm, "Specimen Officer, Business Banking (fictional)")
    watermark(c)


RENDER = {"bankletter": render_bankletter, "gst": render_gst, "pan": render_pan, "cheque": render_cheque, "coi": render_coi,
          "invoice": render_invoice}


def pdf_bytes(kind, form):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setTitle(f"specimen-{kind}")
    if kind == "gst@deccan":
        d = next(m for m in master if m["legal_name"].startswith("Deccan"))
        render_gst(c, form, gstin=d["gstin"], legal=d["legal_name"].upper(), trade="DECCAN ENGINEERING",
                   constitution="Private Limited Company",
                   address="Plot 27, MIDC Bhosari,\nPune, Maharashtra - 411026")
    else:
        RENDER[kind](c, form)
    c.showPage()
    c.save()
    return buf.getvalue()


def degrade(pdf: bytes, angle: float, strength: float) -> Image.Image:
    """Turn a clean PDF page into something that looks scanned / photographed."""
    page = fitz.open(stream=pdf, filetype="pdf")[0]
    pix = page.get_pixmap(dpi=130)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    img = img.crop((0, 0, img.width, int(img.height * 0.55)))  # top part only, like a photo of a card/cheque
    img = img.rotate(angle, expand=True, fillcolor=(205, 200, 190))
    img = img.filter(ImageFilter.GaussianBlur(0.7 * strength))
    img = ImageEnhance.Contrast(img).enhance(0.85)
    # uneven lighting
    grad = Image.linear_gradient("L").resize(img.size).rotate(20)
    shade = Image.merge("RGB", [grad, grad, grad])
    img = Image.blend(img, shade, 0.12 * strength)
    # sensor noise
    noise = Image.effect_noise(img.size, 22 * strength).convert("RGB")
    img = Image.blend(img, noise, 0.07 * strength)
    return img


def write_doc(folder: Path, slot: str, spec: str, form) -> str:
    kind, _, variant = spec.partition("@")
    if kind == "gst" and variant == "deccan":
        kind = "gst@deccan"
    pdf = pdf_bytes(kind, form)
    if variant == "photo":  # phone photo -> JPG
        name = f"{slot}.jpg"
        degrade(pdf, angle=-3.2, strength=1.3).save(folder / name, quality=72)
    elif variant == "scan":  # scanned -> image-only PDF (no text layer)
        name = f"{slot}.pdf"
        degrade(pdf, angle=1.6, strength=0.9).save(folder / name, "PDF", resolution=130)
    else:
        name = f"{slot}.pdf"
        (folder / name).write_bytes(pdf)
    return name


def ground_truth(slot, spec, form):
    kind = spec.split("@")[0]
    b = form["bank"]
    if spec == "gst@deccan":
        d = next(m for m in master if m["legal_name"].startswith("Deccan"))
        return dict(doc_type="gst_certificate", gstin=d["gstin"], legal_name=d["legal_name"].upper())
    if kind == "gst":
        return dict(doc_type="gst_certificate", gstin=form["gstin"], legal_name=form["legal_name"].upper(),
                    trade_name=form["trade_name"].upper(), state=form["address"]["state"])
    if kind == "pan":
        return dict(doc_type="pan_card", pan=form["pan"], name=form["legal_name"].upper())
    if kind == "cheque":
        return dict(doc_type="cancelled_cheque", account_number=b["account_number"], ifsc=b["ifsc"],
                    account_holder=b["account_holder"], bank_name=b["bank_name"].upper())
    if kind == "coi":
        return dict(doc_type="incorporation_certificate", cin=form["cin"], legal_name=form["legal_name"].upper(),
                    pan=form["pan"])
    if kind == "invoice":
        return dict(doc_type="invoice", gstin=form["gstin"])
    if kind == "bankletter":
        return dict(doc_type="bank_letter", account_number=b["account_number"], account_holder=b["account_holder"])
    raise ValueError(kind)


# ----------------------------------------------------------------------------
# Write everything
# ----------------------------------------------------------------------------
def main():
    if SCEN.exists():
        shutil.rmtree(SCEN)
    expected = {}
    for sid, s in S.items():
        slug = sid
        folder = SCEN / slug
        (folder / "docs").mkdir(parents=True)
        form = s["form"]
        uploaded, truth = {}, {}
        for slot, spec in s["docs"].items():
            name = write_doc(folder / "docs", slot, spec, form)
            uploaded[slot] = f"docs/{name}"
            truth[f"docs/{name}"] = ground_truth(slot, spec, form)
        fixes = {}
        for slot, spec in s.get("fix", {}).items():
            (folder / "fix").mkdir(exist_ok=True)
            name = write_doc(folder / "fix", slot, spec, form)
            fixes[slot] = f"fix/{name}"
            truth[f"fix/{name}"] = ground_truth(slot, spec, form)
        submission = dict(scenario_id=sid, **form, documents=uploaded)
        (folder / "submission.json").write_text(json.dumps(submission, indent=2, ensure_ascii=False))
        (folder / "invite.json").write_text(json.dumps(s["invite"], indent=2))
        expected[sid] = dict(title=s["title"], **s["expected"], fix_documents=fixes, fix_fields=s.get("fix_fields", {}), document_truth=truth)
    (OUT / "expected.json").write_text(json.dumps(expected, indent=2, ensure_ascii=False))
    (ROOT / "data" / "vendor_master.json").write_text(json.dumps(master, indent=2))
    print(f"Wrote {len(S)} scenarios and {len(master)} master vendors")


if __name__ == "__main__":
    main()
