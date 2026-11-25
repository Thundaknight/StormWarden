import { useEffect, useState } from 'react';
import { api, getToken } from '../api';
import { useAuth } from '../auth';
import type { User } from '../types';
import { fmtTime } from '../format';

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [auth, setAuth] = useState<{ discordLogin: boolean; passwordLogin: boolean } | null>(null);
  const load = () => {
    api.listUsers().then((r) => setUsers(r.users));
    api.authStatus().then(setAuth);
  };
  useEffect(() => {
    load();
    const q = new URLSearchParams(window.location.search);
    if (q.get('discordLinked')) setMsg({ kind: 'ok', text: 'Discord linked — you can now sign in with Discord.' });
    if (q.get('discordError')) setMsg({ kind: 'error', text: q.get('discordError')! });
    if (q.toString()) window.history.replaceState({}, '', window.location.pathname);
  }, []);
  const mine = users.find((u) => u.id === me?.id);
  const unlink = async () => {
    try { await api.unlinkDiscord(); load(); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };
  const togglePassword = async (disabled: boolean) => {
    if (disabled && !confirm('Turn off password sign-in? Only Discord-linked accounts will be able to sign in. '
      + '(Break-glass: set ALLOW_PASSWORD_LOGIN=1 on the container.)')) return;
    try { await api.setPasswordLogin(disabled); load(); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };

  const add = async () => {
    try { await api.createUser(username, password); setUsername(''); setPassword(''); setMsg({ kind: 'ok', text: 'User added.' }); load(); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };
  const reset = async (u: User) => {
    const isMe = u.id === me?.id;
    const current = isMe ? prompt('Your current password') : undefined;
    if (isMe && current === null) return;
    const pw = prompt(`New password for ${u.username} (min 8 chars)`);
    if (!pw) return;
    try { await api.setPassword(u.id, pw, current || undefined); setMsg({ kind: 'ok', text: 'Password changed.' }); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };
  const del = async (u: User) => {
    if (!confirm(`Delete ${u.username}?`)) return;
    try { await api.deleteUser(u.id); load(); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <span className="muted">Web accounts. Every web user is a full admin — members use Discord, gated by grants.</span>
        </div>
      </div>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div className="card">
        <table className="table">
          <thead><tr><th>Username</th><th>Discord</th><th>Created</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}{u.id === me?.id && <span className="muted"> (you)</span>}</td>
                <td>{u.discord_username || <span className="muted">not linked</span>}</td>
                <td className="muted">{fmtTime(u.created_at)}</td>
                <td className="table-actions">
                  <button className="btn btn-small" onClick={() => reset(u)}>Change password</button>
                  {u.id !== me?.id && <button className="btn btn-small btn-danger-outline" onClick={() => del(u)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Sign in with Discord</h2>
        <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
          Discord sign-in only works for web users who've linked their Discord account here — nobody can sign up through it.
          Set it up on the Discord Bot page first (application ID, client secret, web address).
        </p>
        <div className="btn-row">
          {mine?.discord_username ? (
            <>
              <span>Linked as <strong>{mine.discord_username}</strong></span>
              <button className="btn btn-small" onClick={unlink}>Unlink</button>
            </>
          ) : (
            <button className="btn btn-discord" onClick={() => { window.location.href = `/api/auth/discord/link?token=${encodeURIComponent(getToken())}`; }}>
              Link my Discord account
            </button>
          )}
        </div>
        <hr className="divider" />
        <label className="checkbox-label">
          <input type="checkbox" checked={auth ? !auth.passwordLogin : false} onChange={(e) => togglePassword(e.target.checked)} disabled={!auth?.discordLogin && !!auth?.passwordLogin} />
          Turn off password sign-in (Discord only)
        </label>
        {!auth?.discordLogin && <span className="hint">Enable Discord sign-in on the Discord Bot page before you can turn passwords off.</span>}
      </div>
      <div className="card">
        <h2>Add admin</h2>
        <div className="inline-form">
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input type="password" placeholder="Password (min 8)" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn btn-primary" onClick={add} disabled={!username || password.length < 8}>Add</button>
        </div>
      </div>
    </div>
  );
}
