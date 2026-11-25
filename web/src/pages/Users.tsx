import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { User } from '../types';
import { fmtTime } from '../format';

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const load = () => api.listUsers().then((r) => setUsers(r.users));
  useEffect(() => { load(); }, []);

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
          <thead><tr><th>Username</th><th>Created</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}{u.id === me?.id && <span className="muted"> (you)</span>}</td>
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
