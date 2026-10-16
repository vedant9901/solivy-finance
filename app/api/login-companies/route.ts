import { NextResponse } from "next/server";
import { postgresPool, usesPostgres } from "../../../lib/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (usesPostgres()) {
      const result = await postgresPool().query("SELECT id, name, code FROM public.companies WHERE active = 1 ORDER BY name");
      return NextResponse.json({ companies: result.rows });
    }

    // Load SQLite only in local mode. Avoid module-load filesystem side effects on Vercel.
    const { adminDb } = await import("../../../lib/db");
    const d = adminDb();
    const companies = d.prepare("SELECT id, name, code FROM companies WHERE active = 1 ORDER BY name").all();
    return NextResponse.json({ companies });
  } catch (error: unknown) {
    console.error("GET /api/login-companies failed:", error);
    return NextResponse.json({ error: "Unable to load companies. Check DATABASE_URL and the PostgreSQL companies schema." }, { status: 500 });
  }
}
