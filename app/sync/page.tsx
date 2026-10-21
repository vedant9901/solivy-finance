'use client';
import React,{useCallback,useEffect,useRef,useState} from 'react';

type Result={ok?:boolean;error?:string;mode?:string;pushed?:number;pulled?:number;applied?:number;duplicates?:number;unchanged?:number;conflict?:boolean;last_sync_at?:string;pending_downloads?:number};
const KEY='solivy.sync.config.v1';
export default function SyncPage(){
  const [remoteUrl,setRemoteUrl]=useState('');
  const [remoteCompanyId,setRemoteCompanyId]=useState('');
  const [token,setToken]=useState('');
  const [auto,setAuto]=useState(false);
  const [busy,setBusy]=useState(false);
  const busyRef=useRef(false);
  const [status,setStatus]=useState('Not configured');
  const [result,setResult]=useState<Result|null>(null);
  const [deviceName,setDeviceName]=useState('Offline office PC');
  const [issuedToken,setIssuedToken]=useState('');
  const [pairedCompany,setPairedCompany]=useState('');
  const [pairing,setPairing]=useState(false);
  useEffect(()=>{try{const c=JSON.parse(localStorage.getItem(KEY)||'{}');setRemoteUrl(c.remoteUrl||'');setRemoteCompanyId(c.remoteCompanyId||'');setToken(c.token||'');setAuto(Boolean(c.auto));}catch{}},[]);
  useEffect(()=>{localStorage.setItem(KEY,JSON.stringify({remoteUrl,remoteCompanyId,token,auto}));},[remoteUrl,remoteCompanyId,token,auto]);
  const sync=useCallback(async()=>{
    if(busyRef.current||!navigator.onLine||!remoteUrl.trim()||!remoteCompanyId.trim()||!token.trim())return;
    busyRef.current=true;setBusy(true);setStatus('Synchronizing…');
    try{
      const r=await fetch('/api/sync/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({remote_url:remoteUrl,remote_company_id:Number(remoteCompanyId),device_token:token}),cache:'no-store'});
      const data=await r.json();setResult(data);
      if(!r.ok) setStatus(data.error||'Sync failed'); else setStatus(`Sync complete · ${data.pushed||0} uploaded · ${data.pulled||0} downloaded`);
    }catch(e:any){setStatus(e?.message||'Sync failed. Check network and remote URL.');}
    finally{busyRef.current=false;setBusy(false);}
  },[remoteUrl,remoteCompanyId,token]);
  useEffect(()=>{
    if(!auto)return;
    const onOnline=()=>{void sync();};
    window.addEventListener('online',onOnline);
    const id=window.setInterval(()=>{if(navigator.onLine)void sync();},5*60*1000);
    if(navigator.onLine)void sync();
    return()=>{window.removeEventListener('online',onOnline);window.clearInterval(id);};
  },[auto,sync]);
  return <main className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
    <header><div className="text-sm font-semibold uppercase tracking-wide text-sky-700">SOLIVY Finance</div><h1 className="mt-1 text-3xl font-bold">Offline / Online Sync</h1><p className="mt-2 text-sm text-slate-600">Pair this offline company to one authorized online company. LIVE and TEST must be paired separately.</p></header>
    <section className="rounded-2xl border bg-white p-5 shadow-sm space-y-4">
      <h2 className="text-lg font-semibold">Pair an offline device (run this on the online installation)</h2>
      <p className="text-sm text-slate-600">Sign in as an organization administrator and select the online company and LIVE or TEST environment before generating a token.</p>
      <label className="block text-sm font-medium">Device name<input className="mt-1 w-full rounded-lg border p-3" value={deviceName} onChange={e=>setDeviceName(e.target.value)} maxLength={100}/></label>
      <button disabled={pairing||!deviceName.trim()} onClick={async()=>{setPairing(true);setIssuedToken('');try{const r=await fetch('/api/sync/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({device_name:deviceName}),cache:'no-store'});const j=await r.json();if(!r.ok)throw new Error(j.error||'Pairing failed');setIssuedToken(j.device_token);setPairedCompany(String(j.company_id));setStatus('Device paired. Copy the token to the offline installation now.');}catch(e:any){setStatus(e?.message||'Pairing failed');}finally{setPairing(false);}}} className="rounded-xl border px-5 py-3 font-semibold disabled:opacity-50">{pairing?'Generating…':'Generate one-time pairing token'}</button>
      {issuedToken&&<div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3"><div className="text-sm font-semibold">Destination company ID: {pairedCompany}</div><textarea readOnly value={issuedToken} className="w-full rounded-lg border bg-white p-3 font-mono text-xs" rows={3}/><button onClick={()=>{void navigator.clipboard?.writeText(issuedToken);setStatus('Pairing token copied if clipboard permission was granted.');}} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Copy token</button><p className="text-xs text-amber-900">Shown once. Keep it secret. Enter this token and company ID on the offline installation. Pair LIVE and TEST separately.</p></div>}
    </section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm space-y-4">
      <h2 className="text-lg font-semibold">Connection settings (configure this on the offline installation)</h2>
      <label className="block text-sm font-medium">Online base URL<input className="mt-1 w-full rounded-lg border p-3" placeholder="https://finance.example.com" value={remoteUrl} onChange={e=>setRemoteUrl(e.target.value)}/></label>
      <label className="block text-sm font-medium">Online destination company ID<input className="mt-1 w-full rounded-lg border p-3" type="number" min="1" placeholder="Company ID returned by pairing" value={remoteCompanyId} onChange={e=>setRemoteCompanyId(e.target.value)}/></label>
      <label className="block text-sm font-medium">Device pairing token<input className="mt-1 w-full rounded-lg border p-3" type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} placeholder="Paste one-time token from online admin pairing"/></label>
      <p className="text-xs text-amber-800">The token is stored in this browser's local storage. Use a dedicated device token, restrict access to this Windows account, and revoke the token if the device is lost.</p>
      <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> Automatic sync when online and every 5 minutes while this page is open</label>
      <div className="flex flex-wrap gap-3"><button disabled={busy||!remoteUrl||!remoteCompanyId||!token} onClick={()=>void sync()} className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white disabled:opacity-50">{busy?'Syncing…':'Sync Now'}</button><button onClick={()=>{setRemoteUrl('');setRemoteCompanyId('');setToken('');setAuto(false);setResult(null);setStatus('Not configured');}} className="rounded-xl border px-5 py-3 font-semibold">Clear settings</button></div>
      <div role="status" className="rounded-lg bg-slate-50 p-3 text-sm">{status}</div>
    </section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><h2 className="text-lg font-semibold">Last result</h2>{result?<div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">{[['Uploaded',result.pushed],['Downloaded',result.pulled],['Applied',result.applied],['Duplicates avoided',result.duplicates]].map(([k,v])=><div key={String(k)} className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">{k}</div><div className="mt-1 text-2xl font-bold">{Number(v||0)}</div></div>)}</div>:<p className="mt-2 text-sm text-slate-500">No sync has run yet.</p>}
      <p className="mt-3 text-xs text-slate-500">Conflicts are rejected rather than silently overwriting accounting data. Back up both databases before first pairing. Synchronize only databases belonging to the same company with compatible schema and IDs.</p>
    </section>
  </main>;
}
