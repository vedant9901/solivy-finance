'use client';
import { useCallback, useEffect, useState } from 'react';
import { FiUser, FiShield, FiKey, FiCheck, FiAlertCircle, FiBriefcase, FiClock } from 'react-icons/fi';
import { getJson, sendJson } from '../lib/client-http';
import { ThemeSwitcher, Skeleton } from './ui';

/**
 * Profile & settings (v2.8.0): who is signed in, which organization and environment, what the
 * account may use, the session in effect, appearance, and a password change. Everything shown here
 * comes from /api/profile and the session the server already issued — no new endpoint, no new
 * permission, and nothing about other users is exposed.
 */
export default function ProfilePanel({ companyName, role, menuAccess, mode, canManageOrganisation, onOpenTab }: { companyName: string; role: string; menuAccess: string[]; mode: 'LIVE' | 'TEST'; canManageOrganisation?: boolean; onOpenTab?: (tab: string) => void }) {
  const [profile, setProfile] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm_password: '' });

  const load = useCallback(async () => {
    try { setProfile(await getJson('/api/profile', { group: 'profile' })); }
    catch (e: any) { setError(e?.message || 'Could not load your profile.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const changePassword = async () => {
    setNotice(''); setError('');
    if (form.new_password.length < 12) { setError('The new password must be at least 12 characters.'); return; }
    if (form.new_password !== form.confirm_password) { setError('The new password and its confirmation do not match.'); return; }
    setBusy(true);
    try {
      await sendJson('/api/profile', { current_password: form.current_password, new_password: form.new_password, confirm_password: form.confirm_password });
      setForm({ current_password: '', new_password: '', confirm_password: '' });
      setNotice('Password changed. Other sessions signed in with the old password were ended.');
    } catch (e: any) { setError(e?.message || 'The password could not be changed.'); }
    finally { setBusy(false); }
  };

  const initials = String(profile?.name || profile?.username || '?').trim().split(/\s+/).slice(0, 2).map((w: string) => w[0]?.toUpperCase()).join('');
  const modules: string[] = profile?.modules || menuAccess || [];
  const sessionStart = (() => { try { return sessionStorage.getItem('aksh-login-at') || ''; } catch { return ''; } })();

  return (
    <div className="profile-grid fade-in">
      <div className="grid gap-4">
        <div className="profile-hero">
          <div className="profile-avatar" aria-hidden="true">{initials || <FiUser />}</div>
          <div className="min-w-0">
            <div className="text-lg font-black leading-tight">{profile?.name || profile?.username || <Skeleton className="skeleton-text" />}</div>
            <div className="text-xs opacity-80">{profile?.username ? `@${profile.username}` : ''}{profile?.id ? ` · ID ${profile.id}` : ''}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="chip is-on">{role || profile?.role || 'USER'}</span>
              <span className="chip">{mode}</span>
            </div>
          </div>
        </div>

        <section className="card p-4 sm:p-5">
          <h2 className="flex items-center gap-2 text-sm font-extrabold"><FiBriefcase aria-hidden="true" /> Organisation</h2>
          <dl className="profile-meta mt-3">
            <div className="profile-row"><dt>Organisation</dt><dd>{profile?.organization || companyName || '—'}</dd></div>
            <div className="profile-row"><dt>Organisation ID</dt><dd>{profile?.company_id ?? '—'}</dd></div>
            <div className="profile-row"><dt>Environment</dt><dd>{mode === 'TEST' ? 'TEST (practice data)' : 'LIVE (real books)'}</dd></div>
          </dl>
          {canManageOrganisation && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="secondary btn text-xs" onClick={() => onOpenTab?.('settings')}>Company / TDS settings</button>
              <button type="button" className="secondary btn text-xs" onClick={() => onOpenTab?.('document-settings')}>Document settings</button>
              <button type="button" className="secondary btn text-xs" onClick={() => onOpenTab?.('administration')}>Users &amp; organisations</button>
            </div>
          )}
        </section>

        <section className="card p-4 sm:p-5">
          <h2 className="flex items-center gap-2 text-sm font-extrabold"><FiClock aria-hidden="true" /> Session &amp; security</h2>
          <dl className="profile-meta mt-3">
            <div className="profile-row"><dt>Signed in since</dt><dd>{sessionStart ? new Date(Number(sessionStart) || sessionStart).toLocaleString() : 'This session'}</dd></div>
            <div className="profile-row"><dt>Session cookie</dt><dd>HttpOnly · SameSite=Strict</dd></div>
            <div className="profile-row"><dt>Ends automatically</dt><dd>On sign-out, password change, or when an administrator revokes it</dd></div>
          </dl>
          <p className="muted mt-2 text-xs">Changing your password signs out every other session using the old one.</p>
        </section>
      </div>

      <div className="grid gap-4">
        <section className="card p-4 sm:p-5">
          <h2 className="flex items-center gap-2 text-sm font-extrabold"><FiShield aria-hidden="true" /> Modules you can use</h2>
          <p className="muted mt-1 text-xs">Granted by an administrator. Anything not listed is hidden and refused by the server as well.</p>
          {!profile ? <div className="mt-3"><Skeleton lines={3} /></div> : (
            <div className="chip-list mt-3">
              {role === 'ADMIN' ? <span className="chip is-on">All modules (administrator)</span>
                : modules.length ? modules.map((m) => <span key={m} className="chip is-on">{m.replace(/-/g, ' ')}</span>)
                  : <span className="chip">No modules granted yet</span>}
            </div>
          )}
        </section>

        <section className="card p-4 sm:p-5">
          <h2 className="flex items-center gap-2 text-sm font-extrabold">Appearance</h2>
          <p className="muted mt-1 text-xs">Saved on this device and applied to every screen.</p>
          <div className="mt-3"><ThemeSwitcher /></div>
        </section>

        <section className="card p-4 sm:p-5">
          <h2 className="flex items-center gap-2 text-sm font-extrabold"><FiKey aria-hidden="true" /> Change password</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-semibold sm:col-span-2">Current password
              <input type="password" autoComplete="current-password" value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} />
            </label>
            <label className="text-sm font-semibold">New password
              <input type="password" autoComplete="new-password" value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} />
            </label>
            <label className="text-sm font-semibold">Confirm new password
              <input type="password" autoComplete="new-password" value={form.confirm_password} onChange={(e) => setForm({ ...form, confirm_password: e.target.value })} />
            </label>
          </div>
          <p className="muted mt-2 text-xs">At least 12 characters. Use something you do not use anywhere else.</p>
          {error && <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg p-3 text-sm" style={{ background: 'var(--negative-soft)', color: 'var(--negative)' }}><FiAlertCircle className="mt-0.5 shrink-0" aria-hidden="true" />{error}</p>}
          {notice && <p role="status" className="mt-3 flex items-start gap-2 rounded-lg p-3 text-sm" style={{ background: 'var(--positive-soft)', color: 'var(--positive)' }}><FiCheck className="mt-0.5 shrink-0" aria-hidden="true" />{notice}</p>}
          <button type="button" className="primary btn mt-4 w-full sm:w-auto" disabled={busy} onClick={changePassword}>{busy ? 'Changing…' : 'Change password'}</button>
        </section>
      </div>
    </div>
  );
}
