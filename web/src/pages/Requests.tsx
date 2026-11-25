import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import GrantEditor from '../components/GrantEditor';
import Modal from '../components/Modal';
import type { FeatureRequest, ProjectMap, Settings, SubjectRef, VikunjaProject } from '../types';
import { useGuildMeta } from '../useGuildMeta';
import { fmtTime } from '../format';

export default function Requests() {
  const { meta } = useGuildMeta();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [sync, setSync] = useState(true);
  const [maps, setMaps] = useState<ProjectMap[]>([]);
  const [vprojects, setVprojects] = useState<VikunjaProject[]>([]);
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [editing, setEditing] = useState<Partial<ProjectMap> | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    api.getSettings().then((r) => { setSettings(r.settings); setUrl(r.settings.vikunja_url); setSync(r.settings.vikunja_sync_enabled); });
    api.listProjectMaps().then((r) => setMaps(r.projects));
    api.listRequests().then((r) => setRequests(r.requests));
    api.vikunjaProjects().then((r) => setVprojects(r.projects)).catch(() => setVprojects([]));
  }, []);
  useEffect(load, [load]);

  const saveConn = async () => {
    setMsg(null);
    try {
      await api.saveSettings({ vikunja_url: url, vikunja_token: token, vikunja_sync_enabled: sync });
      setToken('');
      const t = await api.testVikunja();
      setMsg({ kind: 'ok', text: `Connected — ${t.projectCount} projects visible.` });
      load();
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };

  const syncNow = async () => {
    try {
      const r = await api.syncRequests();
      setMsg({ kind: 'ok', text: `Checked ${r.checked} open requests: ${r.posted} comments posted to Discord, ${r.closed} closed.` });
      load();
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };

  const channelName = (id: string) => meta.channels.find((c) => c.id === id)?.name;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <span className="muted"><span className="mono">/request &lt;project&gt;</span> logs a task in Vikunja and opens a Discord thread that syncs both ways.</span>
        </div>
        <button className="btn" onClick={syncNow}>Sync now</button>
      </div>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}

      <div className="card">
        <h2>Vikunja connection</h2>
        <div className="form-grid">
          <label>Vikunja URL<input value={url} placeholder="https://projects.stormconnect.ca" onChange={(e) => setUrl(e.target.value)} /></label>
          <label>API token
            <input type="password" value={token} placeholder={settings?.vikunja_token_set ? '•••••• (saved — leave blank to keep)' : 'tk_…'} onChange={(e) => setToken(e.target.value)} />
            <span className="hint">Vikunja → Settings → API Tokens. Needs Projects (read), Tasks (create/read), Task Comments (create/read).</span>
          </label>
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> Two-way thread ↔ comment sync (requires the bot's Message Content intent)</label>
        <button className="btn btn-primary" onClick={saveConn}>Save &amp; test</button>
      </div>

      <div className="card">
        <div className="card-head-row">
          <h2 style={{ margin: 0 }}>Request projects</h2>
          <button className="btn btn-primary btn-small" onClick={() => setEditing({ key: '', display_name: '', vikunja_project_id: 0, channel_id: '', enabled: 1, grants: [] })}>+ Add project</button>
        </div>
        {maps.length === 0 ? <p className="muted">No projects yet. Map a Discord-facing name to a Vikunja project.</p> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Vikunja project</th><th>Thread channel</th><th>Who can request</th><th /></tr></thead>
            <tbody>
              {maps.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.display_name}</strong> <span className="muted mono">[{p.key}]</span>{!p.enabled && <span className="muted"> (disabled)</span>}</td>
                  <td>{vprojects.find((v) => v.id === p.vikunja_project_id)?.title || `#${p.vikunja_project_id}`}</td>
                  <td>{p.channel_id ? `#${channelName(p.channel_id) || p.channel_id}` : <span className="muted">where /request is used</span>}</td>
                  <td>{p.grants.length ? p.grants.map((g) => (g.subject_type === 'role' ? '@' : '👤') + (g.subject_name || g.subject_id)).join(', ') : <span className="muted">everyone</span>}</td>
                  <td className="table-actions"><button className="btn btn-small" onClick={() => setEditing(p)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Recent requests</h2>
        {requests.length === 0 ? <p className="muted">None yet.</p> : (
          <table className="table">
            <thead><tr><th>Title</th><th>Project</th><th>By</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.task_url ? <a href={r.task_url} target="_blank" rel="noreferrer">{r.title}</a> : r.title}</td>
                  <td>{r.project_name}</td>
                  <td>{r.requester_name}</td>
                  <td>{r.done ? <span className="pill-ok">done</span> : r.thread_id ? 'open · syncing' : 'open · no thread'}</td>
                  <td className="muted">{fmtTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <ProjectModal
          initial={editing} vprojects={vprojects} meta={meta}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function ProjectModal({ initial, vprojects, meta, onClose, onSaved }: {
  initial: Partial<ProjectMap>; vprojects: VikunjaProject[]; meta: ReturnType<typeof useGuildMeta>['meta'];
  onClose: () => void; onSaved: () => void;
}) {
  const [p, setP] = useState({ ...initial });
  const [grants, setGrants] = useState<SubjectRef[]>(initial.grants || []);
  const [error, setError] = useState('');
  const set = (k: keyof ProjectMap, v: unknown) => setP((x) => ({ ...x, [k]: v }));

  const save = async () => {
    try {
      const r = p.id ? await api.updateProjectMap(p.id, p) : await api.createProjectMap(p);
      await api.setProjectGrants(r.project.id, grants);
      onSaved();
    } catch (e: any) { setError(e.message); }
  };
  const remove = async () => {
    if (!p.id || !confirm(`Delete ${p.display_name}? Existing Vikunja tasks are kept.`)) return;
    await api.deleteProjectMap(p.id);
    onSaved();
  };

  return (
    <Modal title={p.id ? `Edit ${p.display_name}` : 'Add request project'} onClose={onClose} wide>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="form-grid">
        <label>Vikunja project
          <select value={p.vikunja_project_id || ''} onChange={(e) => {
            const v = vprojects.find((x) => x.id === parseInt(e.target.value, 10));
            set('vikunja_project_id', v?.id || 0);
            if (v && !p.display_name) {
              set('display_name', v.title);
              if (!p.key) set('key', v.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24));
            }
          }}>
            <option value="">{vprojects.length ? 'Pick a project…' : 'Connect Vikunja first'}</option>
            {vprojects.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
          </select>
        </label>
        <label>Name shown in Discord<input value={p.display_name || ''} onChange={(e) => set('display_name', e.target.value)} placeholder="Frostgate" /></label>
        <label>Short key (thread prefix)<input className="mono" value={p.key || ''} onChange={(e) => set('key', e.target.value.toLowerCase())} placeholder="frostgate" /></label>
        <label>Thread channel
          <select value={p.channel_id || ''} onChange={(e) => set('channel_id', e.target.value)}>
            <option value="">Same channel /request is used in</option>
            {meta.channels.map((c) => <option key={c.id} value={c.id}>{c.type === 'forum' ? '🗂️ ' : '#'}{c.name}</option>)}
          </select>
          <span className="hint">Forum channels get one post per request; text channels get a message with a thread.</span>
        </label>
      </div>
      <label className="checkbox-label"><input type="checkbox" checked={!!p.enabled} onChange={(e) => set('enabled', e.target.checked ? 1 : 0)} /> Enabled</label>
      <h2>Who can request</h2>
      <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>Leave empty to let every member use it.</p>
      <GrantEditor grants={grants as any} onChange={(g) => setGrants(g as any)} meta={meta} />
      <hr className="divider" />
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        {p.id ? <button className="btn btn-danger-outline" onClick={remove}>Delete</button> : <span />}
        <div className="btn-row">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </Modal>
  );
}
