import { useState } from 'react';
import { api } from '../api';
import type { GuildMeta, SubjectRef } from '../types';

export interface FlagDef { key: string; label: string }

type Grant = SubjectRef & Record<string, unknown>;

/**
 * Edits a list of Discord role/user grants. With `flags`, each grant gets per-permission toggles
 * (e.g. view/control/logs); without, a grant is simply "allowed".
 */
export default function GrantEditor({ grants, onChange, meta, flags, defaultFlags }: {
  grants: Grant[];
  onChange: (g: Grant[]) => void;
  meta: GuildMeta;
  flags?: FlagDef[];
  defaultFlags?: Record<string, boolean>;
}) {
  const [roleId, setRoleId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ id: string; name: string }>>([]);
  const [searching, setSearching] = useState(false);

  const has = (t: string, id: string) => grants.some((g) => g.subject_type === t && g.subject_id === id);
  const add = (g: SubjectRef) => {
    if (has(g.subject_type, g.subject_id)) return;
    onChange([...grants, { ...g, ...(defaultFlags || {}) }]);
  };
  const roleColor = (id: string) => meta.roles.find((r) => r.id === id)?.color;

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const r = await api.searchMembers(q);
      setResults(r.members);
      if (!r.members.length && /^\d{15,22}$/.test(q)) setResults([{ id: q, name: `User ${q}` }]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="grant-editor">
      {grants.length === 0 ? (
        <p className="muted" style={{ margin: '4px 0 10px' }}>No grants yet.</p>
      ) : (
        <table className="table grant-table">
          <thead>
            <tr>
              <th>Who</th>
              {flags?.map((f) => <th key={f.key}>{f.label}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {grants.map((g, idx) => (
              <tr key={`${g.subject_type}:${g.subject_id}`}>
                <td>
                  {g.subject_type === 'role' ? (
                    <span className="role-pill" style={{ borderColor: roleColor(g.subject_id) || undefined }}>
                      @{meta.roles.find((r) => r.id === g.subject_id)?.name || g.subject_name || g.subject_id}
                    </span>
                  ) : (
                    <span className="user-pill">👤 {g.subject_name || g.subject_id}</span>
                  )}
                </td>
                {flags?.map((f) => (
                  <td key={f.key}>
                    <input
                      type="checkbox"
                      checked={!!g[f.key]}
                      onChange={(e) => onChange(grants.map((x, i) => (i === idx ? { ...x, [f.key]: e.target.checked } : x)))}
                    />
                  </td>
                ))}
                <td className="table-actions">
                  <button className="btn btn-ghost btn-small" onClick={() => onChange(grants.filter((_, i) => i !== idx))}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="grant-add-row">
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">{meta.roles.length ? 'Add a role…' : 'Bot offline — no roles loaded'}</option>
          {meta.roles.filter((r) => !has('role', r.id)).map((r) => <option key={r.id} value={r.id}>@{r.name}</option>)}
        </select>
        <button
          className="btn btn-small"
          disabled={!roleId}
          onClick={() => {
            const r = meta.roles.find((x) => x.id === roleId);
            if (r) add({ subject_type: 'role', subject_id: r.id, subject_name: r.name });
            setRoleId('');
          }}
        >Add role</button>
      </div>
      <div className="grant-add-row">
        <input
          placeholder="Add a user: name or Discord user ID"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }}
        />
        <button className="btn btn-small" onClick={search} disabled={searching || !query.trim()}>{searching ? '…' : 'Find'}</button>
      </div>
      {results.length > 0 && (
        <div className="chip-list" style={{ marginTop: 6 }}>
          {results.map((m) => (
            <button key={m.id} className="chip" onClick={() => { add({ subject_type: 'user', subject_id: m.id, subject_name: m.name }); setResults([]); setQuery(''); }}>
              + {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
