/**
 * v2.12.3 — resolving an inter-company transfer's links in the destination organization.
 *
 * The defect this exists to fix: a transfer carried its parties and bank/cash accounts **by name**,
 * and the destination was required to hold an account named character-for-character the same. Where
 * it did not, the import failed at **accept** — after the transfer had already been created and was
 * sitting PENDING — with nothing but a name:
 *
 *     Destination organization is missing mapped bank/cash account: Aksh Ent.
 *
 * which named no record, no field and no account the destination actually has, and offered no way
 * to resolve it short of renaming master data in one organization to match the other. The same
 * name-only lookup appeared in four places (the record's own links, the `account_transactions`
 * bundle, the `ledger` bundle, and the party identity match), each throwing its own message.
 *
 * All four go through this module now. What changed, and what deliberately did not:
 *
 *  - **An explicit map is honoured.** The destination may say "this transfer's 'Aksh Ent.' is my
 *    account #12" and the import proceeds. The id is checked to exist in the destination's own
 *    tables before anything is written, so a map cannot point a posting at another organization's
 *    account or at a row that is not there.
 *  - **Nothing is ever guessed.** A near match is offered as a *suggestion* for a person to accept;
 *    it is never applied on its own. Posting a payment to the wrong bank account silently is worse
 *    than refusing to post it, so an unresolved link still stops the import.
 *  - **The failure is reported before it can strand a transfer**, and names the record, the field,
 *    what is missing and what the destination has.
 *
 * Matching itself is unchanged: an account matches on its name exactly (after case folding and
 * trimming), a party on its name plus a GST or PAN agreeing. Those are the identity rules the
 * application already used and they are not loosened here — an explicit map is what covers the
 * cases they do not.
 */

/** What a record needs from the destination before it can be imported. */
export type LinkNeed = {
  kind: 'party' | 'account';
  /** The name as the source organization holds it — the key an explicit map is keyed by. */
  name: string;
  /** Corroborating detail the source captured, shown to the person choosing. */
  detail: string;
  gst?: string;
  pan?: string;
  /** The column on the record, or the bundle this came from. */
  field: string;
  /** The source record's reference (sample/payment/receipt number), for the message. */
  reference: string;
  /**
   * How a party is identified. `full` is the record's own link: the name plus a GST or PAN
   * agreeing. `name` is the ledger bundle, which has only a name to go on and has always matched
   * on it alone — preserved here rather than tightened, which would reject imports that work today.
   */
  identity?: 'full' | 'name';
};

/** A row in the destination the person may choose. */
export type Candidate = { id: number; name: string; detail: string };

export type Unresolved = LinkNeed & {
  candidates: Candidate[];
  /** A near match, offered for confirmation. Never applied automatically. */
  suggestion: Candidate | null;
};

/** The explicit maps a destination user may supply: source name → destination row id. */
export type TransferMaps = { account_map?: Record<string, any>; party_map?: Record<string, any> };

const str = (v: any) => String(v ?? '').trim();

/** The key a supplied map is looked up by: case and inner spacing are not made significant. */
export const mapKey = (name: any) => str(name).toLowerCase().replace(/\s+/g, ' ');

/**
 * A loose key, used **only** to offer a suggestion a person must confirm. Punctuation and the
 * common Indian trading suffixes are dropped, so "Aksh Ent." and "AKSH ENTERPRISES" collapse
 * together. Nothing resolves on this key — see `resolve`.
 */
const loose = (name: any) =>
  mapKey(name)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(ent|enterprise|enterprises|trading|traders|trade|and|co|company|corporation|corp|pvt|private|ltd|limited|llp|inc|the)\b/g, ' ')
    .replace(/\s+/g, '')
    .trim();

/** Read an explicit map, tolerating the case and spacing of the name the client echoed back. */
function mapped(map: Record<string, any> | undefined, name: string): number | null {
  if (!map || typeof map !== 'object') return null;
  const want = mapKey(name);
  for (const [k, v] of Object.entries(map)) {
    if (mapKey(k) !== want) continue;
    const id = Number(v);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  return null;
}

/** Every bank/cash account the destination holds, as choices. */
export function accountCandidates(d: any): Candidate[] {
  const rows = d.prepare('SELECT id,account_name,bank_name,account_type,active FROM company_accounts ORDER BY active DESC,account_name').all() as any[];
  return rows.map((r) => ({
    id: Number(r.id),
    name: str(r.account_name),
    detail: [str(r.account_type) || 'BANK', str(r.bank_name)].filter(Boolean).join(' · ') + (Number(r.active) === 1 ? '' : ' · inactive'),
  }));
}

/**
 * Parties the destination holds that could be the one wanted. The full list can be long, so it is
 * narrowed to those sharing a loose name, a GST or a PAN — and if that finds nothing, the first
 * page of parties by name, so the person is never shown an empty chooser.
 */
export function partyCandidates(d: any, need: { name: string; gst?: string; pan?: string }): Candidate[] {
  const rows = d.prepare('SELECT id,name,gst,pan,active FROM parties WHERE active=1 ORDER BY name LIMIT 2000').all() as any[];
  const key = loose(need.name);
  const gst = str(need.gst).toUpperCase();
  const pan = str(need.pan).toUpperCase();
  const near = rows.filter((r) => (key && loose(r.name) === key) || (gst && str(r.gst).toUpperCase() === gst) || (pan && str(r.pan).toUpperCase() === pan));
  const shown = (near.length ? near : rows).slice(0, 50);
  return shown.map((r) => ({
    id: Number(r.id),
    name: str(r.name),
    detail: [str(r.gst), str(r.pan)].filter(Boolean).join(' · ') || 'no GST/PAN recorded',
  }));
}

/** The one near match, if exactly one candidate shares the loose name. Never auto-applied. */
function suggestion(name: string, candidates: Candidate[]): Candidate | null {
  const key = loose(name);
  if (!key) return null;
  const hits = candidates.filter((c) => loose(c.name) === key);
  return hits.length === 1 ? hits[0] : null;
}

/** An explicit map entry must point at a row the destination actually holds. */
function verify(d: any, kind: 'party' | 'account', id: number): number | null {
  const row = kind === 'account'
    ? d.prepare('SELECT id FROM company_accounts WHERE id=?').get(id)
    : d.prepare('SELECT id FROM parties WHERE id=?').get(id);
  return row ? Number((row as any).id) : null;
}

/**
 * Resolve one link in the destination: an explicit map first, then the application's own identity
 * match. Returns the destination row id, or `null` — never a guess.
 */
export function resolve(d: any, need: LinkNeed, maps?: TransferMaps): number | null {
  const explicit = mapped(need.kind === 'account' ? maps?.account_map : maps?.party_map, need.name);
  if (explicit !== null) {
    const ok = verify(d, need.kind, explicit);
    if (ok === null) throw Error(`The ${need.kind === 'account' ? 'bank/cash account' : 'party'} chosen for "${need.name}" (#${explicit}) does not exist in this organization. Choose again; nothing was imported.`);
    return ok;
  }
  if (!str(need.name)) return null;
  const found = need.kind === 'account'
    ? d.prepare('SELECT id FROM company_accounts WHERE LOWER(TRIM(account_name))=LOWER(TRIM(?)) ORDER BY id LIMIT 1').get(need.name)
    : need.identity === 'name'
    ? d.prepare('SELECT id FROM parties WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) ORDER BY id LIMIT 1').get(need.name)
    : d.prepare(
        `SELECT id FROM parties WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND (COALESCE(UPPER(gst),'')=COALESCE(UPPER(?),'') OR COALESCE(UPPER(pan),'')=COALESCE(UPPER(?),'')) ORDER BY CASE WHEN COALESCE(source_company_id,0)>0 THEN 0 ELSE 1 END,id LIMIT 1`,
      ).get(need.name, need.gst || '', need.pan || '');
  return found ? Number((found as any).id) : null;
}

/** Everything a transfer's payload needs from the destination, in the order it will be imported. */
export function needsOf(payload: any, links: string[], ref: string): LinkNeed[] {
  const out: LinkNeed[] = [];
  const add = (n: LinkNeed) => { if (str(n.name)) out.push(n); };
  for (const item of payload?.rows || []) {
    const reference = str(item?.row?.[ref]) || `record #${str(item?.row?.id)}`;
    for (const k of links) {
      const v = item?.links?.[k];
      if (!v) continue;
      if (k.includes('party')) add({ kind: 'party', name: str(v.name), detail: [str(v.gst), str(v.pan)].filter(Boolean).join(' · ') || 'no GST/PAN recorded', gst: str(v.gst), pan: str(v.pan), field: k, reference });
      else add({ kind: 'account', name: str(v.account_name), detail: [str(v.account_type) || 'BANK', str(v.bank_name)].filter(Boolean).join(' · '), field: k, reference });
    }
  }
  for (const group of payload?.accountingRows || []) {
    const reference = `record #${str(group?.sourceRecordId)}`;
    for (const t of group?.accountTransactions || []) add({ kind: 'account', name: str(t?.account_name), detail: 'bank/cash posting', field: 'account_transactions.account_id', reference });
    for (const l of group?.ledgerRows || []) add({ kind: 'party', name: str(l?.party_name), detail: 'ledger posting', field: 'ledger.party_id', reference, identity: 'name' });
  }
  return out;
}

/** One captured link turned into a need — the same shape `needsOf` builds, for a single row. */
export function needFromLink(kind: 'party' | 'account', v: any, field: string, reference: string): LinkNeed {
  return kind === 'party'
    ? { kind, name: str(v?.name), detail: [str(v?.gst), str(v?.pan)].filter(Boolean).join(' · ') || 'no GST/PAN recorded', gst: str(v?.gst), pan: str(v?.pan), field, reference }
    : { kind, name: str(v?.account_name), detail: [str(v?.account_type) || 'BANK', str(v?.bank_name)].filter(Boolean).join(' · '), field, reference };
}

/** The message for a need that could not be resolved, with the destination's choices attached. */
export function missingFor(d: any, need: LinkNeed): string {
  const candidates = need.kind === 'account' ? accountCandidates(d) : partyCandidates(d, need);
  return missingMessage({ ...need, candidates, suggestion: suggestion(need.name, candidates) });
}

/** Collapse the needs to one entry per distinct name, keeping every record that wants it. */
function distinct(needs: LinkNeed[]) {
  const by = new Map<string, LinkNeed & { references: string[]; fields: string[] }>();
  for (const n of needs) {
    const key = `${n.kind}:${mapKey(n.name)}`;
    const seen = by.get(key);
    if (seen) {
      if (!seen.references.includes(n.reference)) seen.references.push(n.reference);
      if (!seen.fields.includes(n.field)) seen.fields.push(n.field);
      if (!seen.gst && n.gst) seen.gst = n.gst;
      if (!seen.pan && n.pan) seen.pan = n.pan;
    } else by.set(key, { ...n, references: [n.reference], fields: [n.field] });
  }
  return [...by.values()];
}

/**
 * What the destination cannot resolve, with the choices it does have. Reads only; writes nothing,
 * so it is safe to run before creating a transfer and again before accepting one.
 */
export function preflight(d: any, payload: any, links: string[], ref: string, maps?: TransferMaps) {
  const needs = distinct(needsOf(payload, links, ref));
  const unresolved: Array<Unresolved & { references: string[]; fields: string[] }> = [];
  let accounts: Candidate[] | null = null;
  for (const need of needs) {
    let id: number | null = null;
    try { id = resolve(d, need, maps); } catch { id = null; }   // a bad map entry is unresolved here
    if (id !== null) continue;
    const candidates = need.kind === 'account' ? (accounts ??= accountCandidates(d)) : partyCandidates(d, need);
    unresolved.push({ ...need, candidates, suggestion: suggestion(need.name, candidates) });
  }
  return { required: needs.length, unresolved, ok: unresolved.length === 0 };
}

/** The sentence a person reads when a link cannot be resolved. */
export function missingMessage(u: Unresolved & { references?: string[]; fields?: string[] }, totalUnresolved = 1): string {
  const what = u.kind === 'account' ? 'bank/cash account' : 'party';
  const where = (u.references || [u.reference]).slice(0, 3).join(', ');
  const have = u.candidates.length
    ? ` This organization has: ${u.candidates.slice(0, 8).map((c) => `${c.name} (${c.detail})`).join('; ')}${u.candidates.length > 8 ? `; and ${u.candidates.length - 8} more` : ''}.`
    : ` This organization has no ${what} recorded yet.`;
  const hint = u.suggestion
    ? ` "${u.suggestion.name}" looks like it, but a ${what} is never chosen automatically — confirm it below.`
    : '';
  const more = totalUnresolved > 1 ? ` ${totalUnresolved - 1} other link${totalUnresolved === 2 ? '' : 's'} also need${totalUnresolved === 2 ? 's' : ''} choosing.` : '';
  return `This organization has no ${what} matching "${u.name}" (${u.detail}), needed by ${where} for ${u.fields?.join(', ') || u.field}.${have}${hint}${more} Choose the matching ${what} or create it, then accept again. Nothing was imported.`;
}
