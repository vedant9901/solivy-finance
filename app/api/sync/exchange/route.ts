import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { adminDb, db, type Mode } from "../../../../lib/db";
import { withPostgresSQLiteBridge } from "../../../../lib/postgres-sqlite-bridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const excluded = new Set(["sync_meta", "sync_changes", "sync_applied_events", "users", "sqlite_sequence"]);
const canon = (v: any): string => {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canon(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
};
function tokenContext(req: Request) {
  const token = String(req.headers.get("x-solivy-device-token") || "");
  const companyId = Number(req.headers.get("x-aksh-company-id") || 0);
  const mode = String(req.headers.get("x-aksh-mode") || "");
  const deviceId = String(req.headers.get("x-solivy-device-id") || "");
  if (!token || token.length > 300 || !companyId || !["LIVE", "TEST"].includes(mode) || !deviceId || deviceId.length > 100) throw new Error("Invalid sync device credentials.");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const row = adminDb().prepare("SELECT id,company_id,mode,active FROM sync_devices WHERE token_hash=?").get(hash) as any;
  if (!row || !row.active || Number(row.company_id) !== companyId || row.mode !== mode) throw new Error("Sync device is not authorized for this company/environment.");
  adminDb().prepare("UPDATE sync_devices SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  return { companyId, mode: mode as Mode, deviceId };
}
function tableInfo(d: any, table: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || excluded.has(table) || table.startsWith("license_") || table.startsWith("admin_")) throw new Error("Table is not eligible for synchronization.");
  const exists = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) throw new Error("Unknown synchronized table: " + table);
  const cols = d.prepare(`PRAGMA table_info("${table}")`).all() as any[];
  const pk = cols.filter((c) => Number(c.pk) > 0).sort((a, b) => a.pk - b.pk);
  if (!cols.length || !pk.length) throw new Error("Table has no supported primary key.");
  return { cols, pk };
}

function mergeInitialCompanySettings(current: any, incoming: any, cols: any[]) {
  const merged: any = {};
  const conflicts: any[] = [];
  const empty = (v: any) => v === null || v === undefined || v === "";
  for (const col of cols) {
    const name = String(col.name),
      a = current?.[name],
      b = incoming?.[name];
    if (Number(col.pk) > 0) {
      merged[name] = a === undefined ? b : a;
      continue;
    }
    if (canon(a) === canon(b)) {
      merged[name] = a;
      continue;
    }
    if (name === "updated_at" && !empty(a) && !empty(b)) {
      merged[name] = String(a) >= String(b) ? a : b;
      continue;
    }
    if (name === "created_at" && !empty(a) && !empty(b)) {
      merged[name] = String(a) <= String(b) ? a : b;
      continue;
    }
    if (empty(a)) {
      merged[name] = b;
      continue;
    }
    if (empty(b)) {
      merged[name] = a;
      continue;
    }
    conflicts.push({ field: name, existing: a, incoming: b });
    merged[name] = a;
  }
  return { merged, conflicts };
}

function currentRow(d: any, table: string, pkCols: any[], pkObj: any) {
  const where = pkCols.map((c) => `"${c.name}"=?`).join(" AND ");
  const vals = pkCols.map((c) => pkObj[c.name]);
  return d.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...vals) as any;
}
function applyEvent(d: any, e: any, localDeviceId: string) {
  if (!e || typeof e.event_id !== "string" || e.event_id.length > 100 || !["INSERT", "UPDATE", "DELETE"].includes(e.operation)) throw new Error("Invalid sync event.");
  if (d.prepare("SELECT event_id FROM sync_applied_events WHERE event_id=?").get(e.event_id)) return "duplicate";
  const { cols, pk } = tableInfo(d, String(e.table_name));
  const pkObj = JSON.parse(String(e.pk_json || "{}"));
  if (!pk.every((c) => Object.prototype.hasOwnProperty.call(pkObj, c.name))) throw new Error("Invalid primary key in sync event.");
  const current = currentRow(d, e.table_name, pk, pkObj);
  const desired = e.row_json ? JSON.parse(e.row_json) : null;
  const base = e.base_json ? JSON.parse(e.base_json) : null;
  if (current && desired && canon(current) === canon(desired)) {
    d.prepare("INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)").run(e.event_id);
    d.prepare("INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)").run(
      e.event_id,
      e.table_name,
      e.pk_json,
      e.operation,
      e.base_json,
      e.row_json,
      e.origin_device || "remote",
    );
    return "already-current";
  }
  if (base === null && current && e.table_name === "company_settings" && e.operation === "INSERT" && desired && typeof desired === "object") {
    const { merged, conflicts } = mergeInitialCompanySettings(current, desired, cols);
    if (conflicts.length)
      throw Object.assign(new Error(`Conflict on company_settings: non-empty fields differ (${conflicts.map((x: any) => x.field).join(", ")}). Review both versions.`), {
        conflictDetail: {
          table: "company_settings",
          primary_key: pkObj,
          reason: "Initial company settings can be merged only when fields do not disagree. Review the listed fields before retrying.",
          field_conflicts: conflicts,
          base: null,
          current,
          incoming: desired,
        },
      });
    d.prepare("UPDATE sync_meta SET suppress_triggers=1 WHERE id=1").run();
    try {
      const names = cols.map((c: any) => String(c.name)).filter((n: string) => !pk.some((c: any) => c.name === n));
      if (names.length)
        d.prepare(`UPDATE "company_settings" SET ${names.map((n: string) => `"${n}"=?`).join(",")} WHERE ${pk.map((c: any) => `"${c.name}"=?`).join(" AND ")}`).run(
          ...names.map((n: string) => (merged[n] === undefined ? null : merged[n])),
          ...pk.map((c: any) => pkObj[c.name]),
        );
      d.prepare("INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)").run(e.event_id);
      d.prepare("INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)").run(
        e.event_id,
        e.table_name,
        e.pk_json,
        e.operation,
        e.base_json,
        e.row_json,
        e.origin_device || "remote",
      );
      const ownDevice = String((d.prepare("SELECT device_id FROM sync_meta WHERE id=1").get() as any)?.device_id || "remote-device");
      d.prepare("INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)").run(
        crypto.randomUUID(),
        "company_settings",
        e.pk_json,
        "UPDATE",
        JSON.stringify(desired),
        JSON.stringify(merged),
        ownDevice,
      );
    } finally {
      d.prepare("UPDATE sync_meta SET suppress_triggers=0 WHERE id=1").run();
    }
    return "merged-settings";
  }
  if (base === null) {
    if (current)
      throw Object.assign(new Error(`Conflict on ${e.table_name}: record already exists.`), {
        conflictDetail: { table: String(e.table_name), primary_key: pkObj, reason: "A record with this key already exists on the destination.", base: null, current, incoming: desired },
      });
  } else if (!current || canon(current) !== canon(base)) {
    throw Object.assign(new Error(`Conflict on ${e.table_name}: record changed on this side. Review before retrying.`), {
      conflictDetail: {
        table: String(e.table_name),
        primary_key: pkObj,
        reason: "The destination record differs from the version this device edited.",
        base,
        current: current || null,
        incoming: desired,
      },
    });
  }
  d.prepare("UPDATE sync_meta SET suppress_triggers=1 WHERE id=1").run();
  try {
    if (e.operation === "DELETE") {
      if (current) d.prepare(`DELETE FROM "${e.table_name}" WHERE ${pk.map((c) => `"${c.name}"=?`).join(" AND ")}`).run(...pk.map((c) => pkObj[c.name]));
    } else {
      if (!desired || typeof desired !== "object") throw new Error("Missing row payload.");
      const names = cols.map((c) => c.name).filter((n) => Object.prototype.hasOwnProperty.call(desired, n));
      if (!names.length || !pk.every((c) => names.includes(c.name))) throw new Error("Row payload is incomplete.");
      const quoted = names.map((n) => `"${n}"`).join(",");
      const marks = names.map(() => "?").join(",");
      const updates = names
        .filter((n) => !pk.some((c) => c.name === n))
        .map((n) => `"${n}"=excluded."${n}"`)
        .join(",");
      const conflict = pk.map((c) => `"${c.name}"`).join(",");
      const sql = `INSERT INTO "${e.table_name}" (${quoted}) VALUES (${marks}) ON CONFLICT (${conflict}) ${updates ? `DO UPDATE SET ${updates}` : "DO NOTHING"}`;
      d.prepare(sql).run(...names.map((n) => (desired[n] === undefined ? null : desired[n])));
    }
    d.prepare("INSERT OR IGNORE INTO sync_applied_events(event_id) VALUES(?)").run(e.event_id);
    d.prepare("INSERT OR IGNORE INTO sync_changes(event_id,table_name,pk_json,operation,base_json,row_json,origin_device,pushed) VALUES(?,?,?,?,?,?,?,1)").run(
      e.event_id,
      e.table_name,
      e.pk_json,
      e.operation,
      e.base_json,
      e.row_json,
      e.origin_device || "remote",
    );
  } finally {
    d.prepare("UPDATE sync_meta SET suppress_triggers=0 WHERE id=1").run();
  }
  return "applied";
}
async function handler(req: Request) {
  let ctx: any;
  try {
    ctx = tokenContext(req);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unauthorized sync device." }, { status: 401 });
  }
  const d = db(ctx.mode, ctx.companyId);
  try {
    if (req.method === "GET") {
      const u = new URL(req.url);
      const cursor = Math.max(0, Number(u.searchParams.get("cursor") || 0));
      const limit = Math.min(500, Math.max(1, Number(u.searchParams.get("limit") || 200)));
      const events = d
        .prepare(`SELECT seq,event_id,table_name,pk_json,operation,base_json,row_json,origin_device,created_at FROM sync_changes WHERE seq>? AND origin_device<>? ORDER BY seq LIMIT ?`)
        .all(cursor, ctx.deviceId, limit) as any[];
      const max = d.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM sync_changes").get() as any;
      const hasMore = events.length === limit;
      const nextCursor = hasMore ? Number(events[events.length - 1]?.seq || cursor) : Number(max?.n || cursor);
      return NextResponse.json({ ok: true, events, cursor: nextCursor, has_more: hasMore });
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const events = Array.isArray(body.events) ? body.events : [];
      if (!events.length) return NextResponse.json({ ok: true, applied: 0, duplicates: 0 });
      if (events.length > 500) return NextResponse.json({ error: "Maximum 500 events per batch." }, { status: 413 });
      const result: any = { applied: 0, duplicates: 0, alreadyCurrent: 0 };
      const tx = d.transaction(() => {
        for (const e of events) {
          const status = applyEvent(d, e, ctx.deviceId);
          if (status === "duplicate") result.duplicates++;
          else if (status === "already-current") result.alreadyCurrent++;
          else result.applied++;
        }
      });
      try {
        tx();
      } catch (e: any) {
        return NextResponse.json({ error: e?.message || "Sync batch rejected; no changes in this batch were committed.", conflict: true, conflict_detail: e?.conflictDetail || null }, { status: 409 });
      }
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Sync exchange failed." }, { status: 400 });
  }
}
const __wrapped_GET = withPostgresSQLiteBridge(handler);
const __wrapped_POST = withPostgresSQLiteBridge(handler);
export async function GET(req: Request) {
  return __wrapped_GET(req);
}
export async function POST(req: Request) {
  return __wrapped_POST(req);
}
