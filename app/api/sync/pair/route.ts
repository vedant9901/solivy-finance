import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { adminDb } from '../../../../lib/db';
import { withPostgresSQLiteBridge } from '../../../../lib/postgres-sqlite-bridge';
export const runtime = 'nodejs';

async function handler(req: Request) {
  try {
    const companyId = Number(req.headers.get('x-aksh-company-id') || 0);
    const mode = req.headers.get('x-aksh-mode');
    const username = String(req.headers.get('x-aksh-user') || '');
    const role = String(req.headers.get('x-aksh-role') || '');
    if (!companyId || !['LIVE','TEST'].includes(String(mode))) return NextResponse.json({error:'Select a company and environment first.'},{status:400});
    if (role !== 'ADMIN') return NextResponse.json({error:'Only an organization administrator can pair a sync device.'},{status:403});
    const body = await req.json().catch(()=>({}));
    const deviceName = String(body.device_name || 'Offline device').trim().slice(0,100) || 'Offline device';
    const a = adminDb();
    const u = a.prepare('SELECT id,active FROM admin_users WHERE username=?').get(username) as any;
    if (!u || !u.active) return NextResponse.json({error:'Active administrator account not found.'},{status:403});
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const id = crypto.randomUUID();
    a.prepare('INSERT INTO sync_devices(id,token_hash,company_id,mode,user_id,device_name) VALUES(?,?,?,?,?,?)')
      .run(id,tokenHash,companyId,mode,u.id,deviceName);
    return NextResponse.json({ok:true,device_id:id,device_token:token,company_id:companyId,mode,device_name:deviceName,warning:'Copy this token now. It is shown only once. Keep it secret and revoke it if the device is lost.'});
  } catch (e:any) {
    return NextResponse.json({error:e?.message || 'Unable to pair device.'},{status:500});
  }
}
async function revokeHandler(req: Request) {
  try {
    if (String(req.headers.get('x-aksh-role') || '') !== 'ADMIN') return NextResponse.json({error:'Administrator access required.'},{status:403});
    const companyId=Number(req.headers.get('x-aksh-company-id')||0);
    const body=await req.json().catch(()=>({}));
    const deviceId=String(body.device_id||'');
    if(!companyId||!deviceId) return NextResponse.json({error:'device_id is required.'},{status:400});
    const a=adminDb();
    const result=a.prepare('UPDATE sync_devices SET active=0 WHERE id=? AND company_id=?').run(deviceId,companyId);
    if(!result.changes) return NextResponse.json({error:'Device not found for this organization.'},{status:404});
    return NextResponse.json({ok:true,revoked:true});
  } catch(e:any) { return NextResponse.json({error:e?.message||'Unable to revoke sync device.'},{status:500}); }
}
const __wrapped_POST = withPostgresSQLiteBridge(handler);
export async function POST(req:Request){return __wrapped_POST(req);}
const __wrapped_DELETE=withPostgresSQLiteBridge(revokeHandler);
export async function DELETE(req:Request){return __wrapped_DELETE(req);}
