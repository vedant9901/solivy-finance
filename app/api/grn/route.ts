import { NextResponse } from 'next/server';
import { db, sessionMode, type Mode } from '../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../lib/postgres-sqlite-bridge';
import { extractPdfText, renderPage, availableTools } from '../../../lib/grn/extract';
import { engineInfo, engineSelfTest } from '../../../lib/grn/ocr-wasm';
import { parseDocument, linkGrnToBill } from '../../../lib/grn/parse';
import { parseDocumentSet, asParsedDocument, listContext, documentFor } from '../../../lib/grn/multi';
import { buildDraft } from '../../../lib/grn/draft';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GRN scan → draft purchase (v2.10.0).
 *
 *   POST  (multipart: file)            extract, match, propose. SAVES NO ACCOUNTING ENTRY.
 *   GET   ?id=&page=                   a rendered page image, for review and manual entry
 *   GET                                recent documents and what became of them
 *   POST  {action:'link'}              attach a saved purchase to the document it came from
 *   POST  {action:'discard'}           mark a document as not used, with the reason
 *
 * The purchase itself is created by the existing POST /api/purchases from the values the user
 * confirms on the review screen: one accounting path, one set of approved rules, and no way for a
 * recognised value to reach the ledger without a person agreeing to it.
 */
const MAX_BYTES = 15 * 1024 * 1024;

function context(req: Request) {
  const companyId = Number(req.headers.get('x-aksh-company-id') || 0);
  if (!companyId) throw new Error('Select an organization first.');
  return { companyId, mode: sessionMode(req) as Mode, user: String(req.headers.get('x-aksh-user') || '') };
}

async function handler(req: Request) {
  let ctx: { companyId: number; mode: Mode; user: string };
  try { ctx = context(req); } catch (e: any) { return NextResponse.json({ error: e?.message || 'Invalid request.' }, { status: 400 }); }
  const d = db(ctx.mode, ctx.companyId);

  if (req.method === 'GET') {
    const u = new URL(req.url);
    const id = Number(u.searchParams.get('id') || 0);
    const page = Number(u.searchParams.get('page') || 0);
    if (id && page) {
      const row = d.prepare('SELECT pdf FROM grn_document_files WHERE document_id=?').get(id) as any;
      if (!row?.pdf) return NextResponse.json({ error: 'The original document was not kept for this entry, so its pages cannot be shown.' }, { status: 404 });
      const image = renderPage(Buffer.from(row.pdf), Math.max(1, page));
      if (!image) return NextResponse.json({ error: 'This page carries no embedded image, so showing it needs pdftoppm (poppler-utils) on this machine.' }, { status: 503 });
      return new NextResponse(new Uint8Array(image.bytes), { headers: { 'content-type': image.mime, 'cache-control': 'private, no-store' } });
    }
    // v2.11.2: check the OCR engine on this machine without uploading anything. It loads the
    // engine and reports the version, how the file was loaded, and — if it could not be — every
    // way that was tried and why each failed. Local only: no document, no network, nothing stored.
    if (u.searchParams.get('selftest') === '1') {
      const info = engineInfo();
      const test = await engineSelfTest();
      return NextResponse.json({
        ok: test.ok,
        engine: { kind: 'bundled-wasm', available: info.available, reason: info.reason, dir: info.dir, core: info.core, tessdata: info.tessdata, languages: info.languages },
        version: test.version, load_route: test.route, load_attempts: test.attempts, error: test.error, ms: test.ms,
        tools: availableTools(),
        node: process.version, platform: `${process.platform}-${process.arch}`,
      }, { status: test.ok ? 200 : 503 });
    }
    const rows = d.prepare(`SELECT g.id, g.file_name, g.page_count, g.extraction_source, g.status, g.purchase_id, g.party_id, g.note, g.created_at,
        p.sample_no, p.invoice_no, p.net_payable, (SELECT COUNT(*) FROM grn_document_files f WHERE f.document_id=g.id) AS has_pdf
      FROM grn_documents g LEFT JOIN purchases p ON p.id=g.purchase_id ORDER BY g.id DESC LIMIT 50`).all();
    return NextResponse.json({ ok: true, documents: rows, tools: availableTools() });
  }

  if (req.method !== 'POST') return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 });

  const contentType = String(req.headers.get('content-type') || '');
  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => ({} as any));
    const action = String(body?.action || '');
    const id = Number(body?.document_id || 0);
    if (!id) return NextResponse.json({ error: 'Which document?' }, { status: 400 });
    const doc = d.prepare('SELECT id,status,purchase_id FROM grn_documents WHERE id=?').get(id) as any;
    if (!doc) return NextResponse.json({ error: 'That document is not on file.' }, { status: 404 });

    if (action === 'link') {
      const purchaseId = Number(body?.purchase_id || 0);
      const purchase = purchaseId ? d.prepare('SELECT id,party_id FROM purchases WHERE id=?').get(purchaseId) as any : null;
      if (!purchase) return NextResponse.json({ error: 'That purchase is not on file, so it cannot be linked.' }, { status: 404 });
      if (doc.purchase_id && Number(doc.purchase_id) !== purchaseId) return NextResponse.json({ error: `This document is already linked to purchase ${doc.purchase_id}.`, purchase_id: doc.purchase_id }, { status: 409 });
      d.prepare("UPDATE grn_documents SET purchase_id=?, party_id=?, status='linked' WHERE id=?").run(purchaseId, purchase.party_id ?? null, id);
      return NextResponse.json({ ok: true, document_id: id, purchase_id: purchaseId });
    }
    if (action === 'discard') {
      if (doc.purchase_id) return NextResponse.json({ error: `This document is linked to purchase ${doc.purchase_id} and is part of its audit trail; it cannot be discarded.` }, { status: 409 });
      d.prepare("UPDATE grn_documents SET status='discarded', note=? WHERE id=?").run(String(body?.note || '').slice(0, 500), id);
      return NextResponse.json({ ok: true, document_id: id, status: 'discarded' });
    }
    return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
  }

  // ---- upload: extract, match, propose; nothing is posted --------------------------------------
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: 'Attach the PDF as a file upload.' }, { status: 400 }); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'Attach the PDF as a file upload.' }, { status: 400 });
  const bytes = Buffer.from(await (file as File).arrayBuffer());
  if (!bytes.length) return NextResponse.json({ error: 'That file is empty.' }, { status: 400 });
  if (bytes.length > MAX_BYTES) return NextResponse.json({ error: `The document is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.` }, { status: 413 });
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return NextResponse.json({ error: 'That file is not a PDF.' }, { status: 415 });
  const fileName = String((file as File).name || 'document.pdf').slice(0, 200);
  const keepPdf = String(form.get('keep_original') || '') === '1' || process.env.SOLIVY_GRN_STORE_PDF === '1';

  // An encrypted PDF cannot be read by either path; say so instead of reporting an empty document.
  if (/\/Encrypt\s/.test(bytes.subarray(-4096).toString('latin1')) || /\/Encrypt\s/.test(bytes.subarray(0, 4096).toString('latin1'))) {
    return NextResponse.json({ error: 'This PDF is password-protected. Remove the protection (open it and save an unprotected copy) and upload it again.', code: 'ENCRYPTED_PDF' }, { status: 422 });
  }
  const extraction = await extractPdfText(bytes);
  // A document whose text could not be read is no longer a dead end (v2.10.2). The built-in reader
  // gives the real page count and, for a scan, the page images, so the pages are shown and the
  // values are typed in against them — through the same review screen, the same validation and the
  // same calculation. Nothing is proposed: every field starts empty and the blocking points name
  // what must be entered.
  const manualEntry = !extraction.pages.length;
  if (manualEntry && !extraction.page_count) {
    return NextResponse.json({ ok: false, error: 'This PDF could not be read at all: no pages were found in it. The file may be damaged — open it to check, or save a fresh copy and upload that.', extraction, tools: availableTools() }, { status: 422 });
  }
  const ocrPages = extraction.pages.map((p) => ({ page: p.page, text: p.text }));
  const parsed = parseDocument(ocrPages);
  const link = linkGrnToBill(parsed.grn, parsed.bill);
  const companyRule = Number((d.prepare('SELECT discount_after_quality FROM company_settings WHERE id=1').get() as any)?.discount_after_quality ?? 1);

  // v2.12.0: the whole document, not its first GRN. Every data row of a consignment list is its
  // own GRN with its own draft; every page is classified and kept; bills are linked to rows on
  // corroborating evidence. The single `draft` below stays the first row's, so the existing
  // review screen and every existing test keep working unchanged.
  const set = parseDocumentSet(ocrPages);
  const listPage = set.pages.find((pg) => pg.kind === 'grn-list');
  const listDetails = listPage ? listContext(ocrPages.find((pg) => pg.page === listPage.page)?.text || '') : {};
  const rowDrafts = set.grns.map((row) => {
    const doc = documentFor(set, row.id);
    const asParsed = asParsedDocument(row, doc, listDetails);
    return {
      grn_id: row.id, page: row.page, row: row.row,
      document_page: doc?.page ?? null,
      draft: buildDraft(d, asParsed as any, { documentSha: `${extraction.sha256}:${row.id}`, companyDiscountRule: companyRule }),
    };
  });

  // The primary draft stays what it has always been: the whole-document read. A list's rows are
  // offered separately in `grns`, so adding them cannot change what a single-GRN document produces.
  const draft = buildDraft(d, parsed, { documentSha: extraction.sha256, companyDiscountRule: companyRule });
  if (!link.linked && parsed.grn && parsed.bill) {
    draft.warnings.unshift({ code: 'PAGES_MAY_NOT_MATCH', severity: 'review', message: `The GRN and the bill may not belong together: ${link.reasons.join(' ')}` });
  }

  const stored = d.prepare(`INSERT INTO grn_documents(file_name,file_sha256,page_count,extraction_source,extracted_json,draft_json,status,created_by)
      VALUES(?,?,?,?,?,?,'extracted',?)`)
    .run(fileName, extraction.sha256, extraction.page_count, extraction.source,
      JSON.stringify({ pages: extraction.pages.map((p) => ({ page: p.page, source: p.source, text: p.text.slice(0, 8000) })), notes: extraction.notes, diagnostics: extraction.diagnostics, engine: { kind: extraction.engine.kind, version: extraction.engine.version, language_requested: extraction.engine.language_requested, psm: extraction.engine.psm }, parsed, link }),
      JSON.stringify(draft), ctx.user);
  // The pages can only be shown from a kept copy, so a document that must be read by eye keeps one
  // whether or not the upload asked to. It stays on this machine: `grn_document_files` is local-only
  // and excluded from synchronisation, and discarding the entry deletes it.
  const keepForViewing = keepPdf || (manualEntry && extraction.viewable_pages.length > 0);
  if (keepForViewing) d.prepare('INSERT OR REPLACE INTO grn_document_files(document_id,pdf) VALUES(?,?)').run(Number(stored.lastInsertRowid), bytes);

  return NextResponse.json({
    ok: true, document_id: Number(stored.lastInsertRowid), file_name: fileName,
    manual_entry: manualEntry,
    extraction: { source: extraction.source, page_count: extraction.page_count, sha256: extraction.sha256, notes: extraction.notes, tools: extraction.tools, native: extraction.native, viewable_pages: extraction.viewable_pages, pages: extraction.pages.map((p) => ({ page: p.page, source: p.source })), diagnostics: extraction.diagnostics, engine: extraction.engine, ms: extraction.ms },
    recognised: { grn: Boolean(parsed.grn), bill: Boolean(parsed.bill), grn_page: parsed.grn_page, bill_page: parsed.bill_page, unrecognised_pages: parsed.unrecognised_pages },
    link, parsed, draft, original_kept: keepForViewing,
    // The whole document. `grns` is one entry per consignment row, each with its own draft.
    grns: set.grns.map((row) => {
      const entry = rowDrafts.find((r) => r.grn_id === row.id)!;
      return { ...row, document_page: entry.document_page, draft: entry.draft };
    }),
    documents: set.documents,
    matches: set.matches,
    page_classifications: set.pages,
    totals: set.totals,
    counts: set.counts,
  });
}

const __wrapped_GET = withPostgresSQLiteBridge(handler);
const __wrapped_POST = withPostgresSQLiteBridge(handler);
export async function GET(req: Request) { return __wrapped_GET(req); }
export async function POST(req: Request) { return __wrapped_POST(req); }
