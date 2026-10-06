import { NextResponse } from "next/server";
import { db, adminDb, Mode } from "../../../lib/db";
import jsPDF from "jspdf";

const clean = (v: any) => String(v ?? "").trim();
const money = (v: any) => `₹${Math.round(Number(v || 0)).toLocaleString("en-IN")}`;
const num = (v: any) => Math.round(Number(v || 0));
const kg = (v: any) => num(v).toLocaleString("en-IN");
const dateText = (v: any) => {
  const s = clean(v);
  if (!s) return "";
  const d = new Date(s + "T00:00:00");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }).replace(/ /g, "-");
};
function words(n: number) {
  n = Math.round(Math.abs(n));
  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const under = (x: number): string =>
    x < 20 ? ones[x] : x < 100 ? tens[Math.floor(x / 10)] + (x % 10 ? " " + ones[x % 10] : "") : ones[Math.floor(x / 100)] + " Hundred" + (x % 100 ? " " + under(x % 100) : "");
  if (n === 0) return "Zero";
  let s = "";
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  const thousand = Math.floor(n / 1e3);
  n %= 1e3;
  if (crore) s += under(crore) + " Crore ";
  if (lakh) s += under(lakh) + " Lakh ";
  if (thousand) s += under(thousand) + " Thousand ";
  if (n) s += under(n);
  return s.trim();
}
function bool(settings: any, key: string, def = true) {
  return settings?.[key] === undefined ? def : !!settings[key];
}
function text(doc: any, value: any, x: number, y: number, maxWidth?: number, opts: any = {}) {
  const v = clean(value);
  if (!v) return false;
  doc.text(maxWidth ? doc.splitTextToSize(v, maxWidth) : v, x, y, opts);
  return true;
}
function right(doc: any, value: any, x: number, y: number) {
  const v = clean(value);
  if (!v) return false;
  doc.text(v, x, y, { align: "right" });
  return true;
}

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const mode = (u.searchParams.get("mode") || "LIVE") as Mode;
    const id = Number(u.searchParams.get("id"));
    const companyId = Number(req.headers.get("x-aksh-company-id") || u.searchParams.get("company_id") || 1);
    const billType = u.searchParams.get("bill_type") || "purchase";
    const thirdPartyId = Number(u.searchParams.get("third_party_id") || 0);
    if (!id) throw Error("Purchase id is required");

    const d = await db(mode, companyId);
    const row = (await d
      .prepare(
        `SELECT p.*,x.name party_name,x.address,x.contact,x.gst,x.pan,b.bank_name,b.account_holder,b.account_number,b.ifsc,b.branch
    FROM purchases p JOIN parties x ON x.id=p.party_id
    LEFT JOIN bank_accounts b ON b.id=(SELECT id FROM bank_accounts WHERE party_id=x.id ORDER BY is_primary DESC,id LIMIT 1)
    WHERE p.id=?`,
      )
      .get(id)) as any;
    if (!row) throw Error("Purchase not found");

    let toParty = { name: row.party_name, address: row.address, contact: row.contact, gst: row.gst, pan: row.pan };
    if (billType === "third-party") {
      if (!thirdPartyId) throw Error("Third party is required");
      const tp = (await d.prepare("SELECT name,address,contact,gst,pan FROM third_parties WHERE id=? AND active=1").get(thirdPartyId)) as any;
      if (!tp) throw Error("Third party not found");
      toParty = tp;
    }

    const company = (await adminDb()).prepare("SELECT id,name,code,address,city,state,email,gstin,pan,financial_year FROM companies WHERE id=?").get(companyId) as any;
    if (!company) throw Error("Company not found");
    const companyBank = (await d.prepare("SELECT * FROM company_accounts WHERE active=1 ORDER BY id LIMIT 1").get()) as any;
    const raw = (await d.prepare("SELECT commercial_bill_settings FROM company_settings WHERE id=1").get()) as any;
    let s: any = {};
    try {
      s = JSON.parse(raw?.commercial_bill_settings || "{}");
    } catch {}

    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const pageW = 210,
      pageH = 297,
      L = 11.5,
      R = 198.5,
      W = R - L;
    const black = [25, 25, 25] as const;
    doc.setTextColor(...black);
    doc.setDrawColor(...black);
    doc.setLineWidth(0.28);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("INVOICE", 105, 9, { align: "center" });

    // This follows the supplied one-page invoice: company + invoice meta, buyer, goods grid, deductions, total, words, declaration and bank block.
    const top = 14.5,
      metaX = 137,
      buyerTop = 58,
      buyerBottom = 88,
      metaBottom = 58;
    const leftRight = metaX;
    doc.rect(L, top, leftRight - L, metaBottom - top);
    doc.rect(metaX, top, R - metaX, metaBottom - top);
    doc.rect(L, buyerTop, leftRight - L, buyerBottom - buyerTop);
    doc.rect(metaX, buyerTop, R - metaX, buyerBottom - buyerTop);

    // Company block — no red/green colouring: those colours in the supplied image are annotation, not document styling.
    let y = top + 7;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    text(doc, company.name || "SOLIVY", L + 3.5, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.8);
    for (const line of [company.address, company.city, company.state].map(clean).filter(Boolean)) {
      text(doc, line, L + 3.5, y, 118);
      y += 4;
    }
    if (bool(s, "show_company_gst") && clean(company.gstin)) {
      text(doc, `GSTIN : ${company.gstin}`, L + 3.5, y);
      y += 4;
    }
    if (bool(s, "show_company_pan") && clean(company.pan)) {
      text(doc, `PAN : ${company.pan}`, L + 3.5, y);
      y += 4;
    }
    if (bool(s, "show_company_email") && clean(company.email)) {
      text(doc, `E-Mail : ${company.email}`, L + 3.5, y);
    }

    // Right metadata grid: retain the source layout but omit empty values.
    const metaRows = [
      ["Invoice No.", row.invoice_no || row.sample_no, "Dated", dateText(row.purchase_date)],
      ["Mode/Terms of Payment", row.payment_due_days ? `Due after ${row.payment_due_days} days` : "", "", ""],
      ["Reference No. & Date.", row.invoice_no ? `${row.invoice_no} dt. ${dateText(row.purchase_date)}` : "", "Other References", billType === "third-party" ? "3rd Party Bill" : ""],
      ["Buyer's Order No.", row.invoice_no || "", "Dated", dateText(row.purchase_date)],
      ["Sample No.", bool(s, "show_sample_no") ? row.sample_no : "", "Dated", dateText(row.purchase_date)],
      ["Terms of Delivery", "", "", ""],
    ];
    const rh = (metaBottom - top) / 6;
    for (let i = 1; i < 6; i++) doc.line(metaX, top + i * rh, R, top + i * rh);
    doc.line(metaX + 31, top, metaX + 31, metaBottom);
    doc.line(metaX + 72, top, metaX + 72, metaBottom);
    doc.line(metaX + 102, top, metaX + 102, metaBottom);
    doc.setFontSize(7.2);
    metaRows.forEach((r, i) => {
      const yy = top + i * rh + 4.1;
      if (clean(r[0])) {
        doc.setFont("helvetica", "bold");
        text(doc, r[0], metaX + 2, yy, 28);
      }
      if (clean(r[1])) {
        doc.setFont("helvetica", "normal");
        text(doc, r[1], metaX + 33, yy, 37);
      }
      if (clean(r[2])) {
        doc.setFont("helvetica", "bold");
        text(doc, r[2], metaX + 74, yy, 27);
      }
      if (clean(r[3])) {
        doc.setFont("helvetica", "normal");
        text(doc, r[3], metaX + 104, yy, 30);
      }
    });

    // Buyer block.
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.2);
    text(doc, "Buyer (Bill to)", L + 3.5, buyerTop + 5);
    doc.setFontSize(9);
    text(doc, toParty.name, L + 3.5, buyerTop + 11, 115);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.8);
    let by = buyerTop + 16;
    for (const line of [
      toParty.address,
      toParty.contact ? `Contact : ${toParty.contact}` : "",
      bool(s, "show_party_gst") && toParty.gst ? `GSTIN : ${toParty.gst}` : "",
      bool(s, "show_party_pan") && toParty.pan ? `PAN : ${toParty.pan}` : "",
    ]
      .map(clean)
      .filter(Boolean)) {
      text(doc, line, L + 3.5, by, 118);
      by += 4;
    }

    const tableTop = 88,
      tableBottom = 232;
    const xs = [L, 21.5, 93.5, 119, 139, 157, 178, R];
    doc.rect(L, tableTop, W, tableBottom - tableTop);
    for (let i = 1; i < xs.length - 1; i++) doc.line(xs[i], tableTop, xs[i], tableBottom);
    doc.line(L, tableTop + 11, R, tableTop + 11);
    const heads = ["Sl\nNo.", "Description of Goods", "HSN/SAC", "Quantity", "Rate", "per", "Amount"];
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    heads.forEach((h, i) => h.split("\n").forEach((v, j) => text(doc, v, xs[i] + 2, tableTop + 4.8 + j * 3.2)));

    let yy = tableTop + 17;
    const description = clean(row.goods_description) || clean(row.notes);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    text(doc, "1", xs[0] + 2, yy);
    doc.setFont("helvetica", "bold");
    if (description) text(doc, description, xs[1] + 2, yy, 69);
    doc.setFont("helvetica", "normal");
    if (num(row.bags_qty) > 0) text(doc, `${kg(row.bags_qty)} Bags`, xs[1] + 2, yy + 5, 69);
    if (bool(s, "show_hsn") && clean(row.hsn)) text(doc, row.hsn, xs[2] + 2, yy, 24);
    if (bool(s, "show_quantity")) text(doc, `${kg(row.net_weight)} Kg`, xs[3] + 2, yy);
    if (bool(s, "show_rate")) text(doc, Number(row.rate || 0).toFixed(2), xs[4] + 2, yy);
    text(doc, "Kg", xs[5] + 2, yy);
    if (bool(s, "show_amount")) right(doc, Number(row.gross_amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), xs[7] - 2, yy);

    // Deductions are printed in the same large description area as the supplied invoice.
    let ly = yy + 17;
    const less: [string, number, string][] = [
      ["Unload Charges", Number(row.unload_charge || 0), "include_unload"],
      ["Driver Rokdi", Number(row.driver_rokdi || 0), "include_driver_rokdi"],
      ["Freight", Number(row.freight || 0), "include_freight"],
      ["Moisture", Number(row.moisture || 0), "include_moisture"],
      ["Discount", Number(row.discount_amount || 0), "include_discount"],
      ["Quality Deduct", Number(row.quality_deduct_amount || 0), "include_quality_deduct"],
      ["Other Charges", Number(row.other_charges || 0), "include_other_charges"],
    ];
    for (const [label, val, key] of less) {
      if (val === 0 || !bool(s, key, true)) continue;
      doc.setFont("helvetica", "normal");
      text(doc, "Less :", xs[1] + 2, ly);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.8);
      doc.text(label, xs[3] - 2, ly, { align: "right" });
      doc.setFont("helvetica", "normal");
      right(doc, `(-)${Math.round(val).toLocaleString("en-IN")}`, xs[7] - 2, ly);
      ly += 5;
    }
    const included = less.filter(([, v, k]) => v !== 0 && bool(s, k, true)).reduce((a, [, v]) => a + v, 0);
    const displayedTotal = Math.max(0, Math.round(Number(row.gross_amount || 0) - included));
    doc.line(xs[2], tableBottom - 8, R, tableBottom - 8);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.text("Total", xs[2] - 2, tableBottom - 3, { align: "right" });
    if (bool(s, "show_quantity")) text(doc, `${kg(row.net_weight)} Kg`, xs[3] + 2, tableBottom - 3);
    right(doc, money(displayedTotal), xs[7] - 2, tableBottom - 3);

    // Bottom block exactly follows the reference's three-column visual balance.
    const bottomTop = 232;
    doc.line(L, bottomTop, R, bottomTop);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.3);
    text(doc, "Amount Chargeable (in words)", L, bottomTop + 5);
    doc.setFontSize(8);
    text(doc, `INR ${words(displayedTotal)} Only`, L, bottomTop + 11, 82);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    right(doc, "E. & O.E", R, bottomTop + 11);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    text(doc, "Declaration", L, bottomTop + 25);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.3);
    text(doc, "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.", L, bottomTop + 31, 86);

    const bankX = 111;
    if (bool(s, "show_bank_details")) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.5);
      text(doc, "Company's Bank Details", bankX, bottomTop + 25);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.2);
      let bY = bottomTop + 31;
      const bankLines = [
        companyBank?.account_holder ? `A/c Holder's Name : ${companyBank.account_holder}` : "",
        companyBank?.bank_name ? `Bank Name : ${companyBank.bank_name}` : "",
        companyBank?.account_number ? `A/c No. : ${companyBank.account_number}` : "",
        companyBank?.branch || companyBank?.ifsc ? `Branch & IFS Code : ${[companyBank?.branch, companyBank?.ifsc].filter(Boolean).join(" & ")}` : "",
      ]
        .map(clean)
        .filter(Boolean);
      for (const line of bankLines) {
        text(doc, line, bankX, bY, 84);
        bY += 4.2;
      }
    }
    if (bool(s, "show_signature")) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.5);
      right(doc, `for ${clean(company.name)}`, R, bottomTop + 46);
      doc.line(151, bottomTop + 52, R, bottomTop + 52);
      doc.setFont("helvetica", "normal");
      right(doc, "Authorised Signatory", R, bottomTop + 57);
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text("This is a Computer Generated Invoice", 105, 294, { align: "center" });

    const bytes = new Uint8Array(doc.output("arraybuffer"));
    const safe = (clean(row.invoice_no) || clean(row.sample_no) || `purchase-${id}`).replace(/[^A-Za-z0-9_-]/g, "_");
    return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="Commercial-Bill-${safe}.pdf"` } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unable to generate commercial bill" }, { status: 500 });
  }
}
