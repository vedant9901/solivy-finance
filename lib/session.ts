import crypto from 'crypto';

export const COOKIE = 'aksh_session';

// Resolve the secret at request time, not during Next.js build-time module evaluation.
// Production still fails closed if the secret is missing when a session is signed/verified.
function getSessionSecret() {
  const value = String(process.env.SESSION_SECRET || '').trim();
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be configured in production');
  }
  return 'aksh-local-dev-secret-change-this';
}

export function hashPassword(password:string){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(password,salt,64).toString('hex');return `${salt}:${hash}`;}
export function verifyPassword(password:string,stored:string){try{const [salt,hex]=String(stored||'').split(':');if(!salt||!hex)return false;const actual=crypto.scryptSync(password,salt,64);const expected=Buffer.from(hex,'hex');return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);}catch{return false}}
export function signSession(username:string,role:string,companyId:number,mode:'LIVE'|'TEST'='LIVE'){const secret=getSessionSecret();const payload=Buffer.from(JSON.stringify({u:username,r:role,c:companyId,m:mode,e:Date.now()+1000*60*60*12})).toString('base64url');const sig=crypto.createHmac('sha256',secret).update(payload).digest('base64url');return `${payload}.${sig}`;}
export function verifySession(token:string|undefined){try{if(!token)return null;const secret=getSessionSecret();const [payload,sig]=token.split('.');if(!payload||!sig)return null;const expected=crypto.createHmac('sha256',secret).update(payload).digest('base64url');if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;const x=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));if(!x?.u||Number(x.e)<Date.now())return null;return x;}catch{return null}}
