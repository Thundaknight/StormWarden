import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import GrantEditor from '../components/GrantEditor';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import type { ContainerGrant, HostContainer, ManagedContainer } from '../types';
import { useGuildMeta } from '../useGuildMeta';

const FLAGS = [
  { key: 'can_view', label: 'View' },
  { key: 'can_control', label: 'Start/Stop/Restart' },
];

export default function Containers() {
  const [containers, setContainers] = useState<ManagedContainer[]>([]);
  const [dockerError, setDockerError] = useState('');
  const [ssError, setSsError] = useState('');
  const [ssPath, setSsPath] = useState('');
  const [ssEditing, setSsEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ManagedContainer | null>(null);
  const [logsFor, setLogsFor] = useState<ManagedContainer | null>(null);

  const load = useCallback(() => {
    api.listContainers().then((r: any) => { setContainers(r.containers); setDockerError(r.dockerError); setSsError(r.stormsmithError || ''); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { api.getSettings().then((r) => setSsPath(r.settings.stormsmith_db_path)); }, []);
  const saveSsPath = async () => {
    try { await api.saveSettings({ stormsmith_db_path: ssPath }); setSsEditing(false); load(); } catch (e: any) { setError(e.message); }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (c: ManagedContainer, action: 'start' | 'stop' | 'restart') => {
    if (action === 'stop' && !confirm(`Stop ${c.display_name}?`)) return;
    setBusy(c.id);
    try { await api.containerAction(c.id, action); load(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  return (
    <div className="dashboard">
      <div className="dashboard-bg" aria-hidden="true" />
      <div className="page-head">
        <div>
          <h1>Containers</h1>
          <span className="muted">Containers StormWarden manages, and who in Discord can touch them.</span>
        </div>
        <div className="btn-row">
          <button className="btn btn-ghost btn-small" onClick={() => setSsEditing(!ssEditing)}>Stormsmith DB path</button>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add container</button>
        </div>
      </div>
      {dockerError && <div className="alert alert-error">Docker unreachable: {dockerError}</div>}
      {(ssError || ssEditing) && (
        <div className="alert alert-warn">
          {ssError && <div>Can't read Stormsmith's server list ({ssError}). Game servers it manages can't be recognised until this is fixed.</div>}
          <div className="inline-form" style={{ marginTop: 8 }}>
            <input className="mono" value={ssPath} onChange={(e) => setSsPath(e.target.value)} />
            <button className="btn btn-small" onClick={saveSsPath}>Save path</button>
          </div>
        </div>
      )}
      {error && <div className="alert alert-error">{error}</div>}
      {containers.length === 0 && !dockerError && (
        <div className="card empty-state muted">No containers yet. Add the ones you want Discord members to be able to manage.</div>
      )}
      <div className="server-grid">
        {containers.map((c) => (
          <div key={c.id} className={`card server-card server-card-${c.state}`}>
            <div className="server-card-head">
              <div>
                <div className="server-name">{c.display_name}</div>
                <div className="server-meta">
                  <span className="game-badge mono">{c.container_name}</span>
                  {c.compose_project && <span className="game-badge">compose: {c.compose_project}</span>}
                </div>
              </div>
              <StatusBadge state={c.state} />
            </div>
            {c.protected && (
              <div className="alert alert-warn" style={{ margin: '8px 0 0' }}>
                🔒 {c.protected === 'self' ? 'This is StormWarden itself — it can\'t control itself.' : 'Now managed by Stormsmith — locked here.'} Remove it from StormWarden.
              </div>
            )}
            {c.description && <p className="muted" style={{ margin: '8px 0 0' }}>{c.description}</p>}
            <div className="server-status-text muted">{c.status}</div>
            <div className="btn-row controls-row">
              <button className="btn btn-small btn-success" disabled={!!c.protected || busy === c.id || c.state === 'running'} onClick={() => act(c, 'start')}>Start</button>
              <button className="btn btn-small" disabled={!!c.protected || busy === c.id || c.state !== 'running'} onClick={() => act(c, 'restart')}>Restart</button>
              <button className="btn btn-small btn-danger-outline" disabled={!!c.protected || busy === c.id || c.state !== 'running'} onClick={() => act(c, 'stop')}>Stop</button>
              <button className="btn btn-small" onClick={() => setLogsFor(c)}>Logs</button>
              <button className="btn btn-small" onClick={() => setEditing(c)}>Access</button>
            </div>
            <div className="grant-summary">
              {c.grants.length === 0 && <span className="muted" style={{ fontSize: '0.8rem' }}>Discord: admins only</span>}
              {c.grants.map((g) => (
                <span key={g.subject_type + g.subject_id} className={g.subject_type === 'role' ? 'role-pill' : 'user-pill'}>
                  {g.subject_type === 'role' ? '@' : '👤 '}{g.subject_name || g.subject_id}
                  <span className="flag-tags">{g.can_control ? 'start/stop/restart' : 'view'}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {adding && <AddContainerModal onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load(); }} />}
      {editing && <AccessModal container={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {logsFor && <LogsModal container={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  );
}

function AddContainerModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [list, setList] = useState<HostContainer[] | null>(null);
  const [selected, setSelected] = useState<HostContainer | null>(null);
  const [filter, setFilter] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { api.availableContainers().then((r) => setList(r.containers)).catch((e) => setError(e.message)); }, []);

  const submit = async () => {
    if (!selected) return;
    try { await api.addContainer(selected.name, name || selected.name, desc); onAdded(); } catch (e: any) { setError(e.message); }
  };
  const shown = (list || []).filter((c) => !filter || c.name.includes(filter) || c.image.includes(filter) || c.composeProject.includes(filter));

  return (
    <Modal title="Add container" onClose={onClose}>
      {error && <div className="alert alert-error">{error}</div>}
      <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
      <div className="container-list">
        {list === null && <span className="muted">Loading…</span>}
        {shown.map((c) => (
          <button
            key={c.name}
            className={`container-row${selected?.name === c.name ? ' selected' : ''}`}
            disabled={c.managed || !!c.protected}
            onClick={() => { setSelected(c); setName(c.name); }}
          >
            <span>
              <span className="container-name">{c.name}</span>
              <span className="hint">
                {c.protected === 'self' ? '🔒 StormWarden itself' : c.protected === 'stormsmith' ? '🔒 managed by Stormsmith'
                  : c.managed ? 'already added' : `${c.image}${c.composeProject ? ` · compose: ${c.composeProject}` : ''}`}
              </span>
            </span>
            <StatusBadge state={c.state} />
          </button>
        ))}
      </div>
      {selected && (
        <div style={{ marginTop: 14 }}>
          <label>Display name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Description (shown in Discord)<input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Arctic Academy role manager bot" /></label>
          {selected.composeWorkingDir && <p className="hint">Compose working dir on host: <span className="mono">{selected.composeWorkingDir}</span> — handy as a script working directory.</p>}
          <button className="btn btn-primary" onClick={submit}>Add {selected.name}</button>
        </div>
      )}
    </Modal>
  );
}

function AccessModal({ container, onClose, onSaved }: { container: ManagedContainer; onClose: () => void; onSaved: () => void }) {
  const { meta } = useGuildMeta();
  const [grants, setGrants] = useState<ContainerGrant[]>(container.grants.map((g) => ({ ...g, can_view: !!g.can_view, can_control: !!g.can_control, can_logs: !!g.can_logs })));
  const [name, setName] = useState(container.display_name);
  const [desc, setDesc] = useState(container.description);
  const [error, setError] = useState('');

  const save = async () => {
    try {
      await api.updateContainer(container.id, name, desc);
      await api.setContainerGrants(container.id, grants);
      onSaved();
    } catch (e: any) { setError(e.message); }
  };
  const remove = async () => {
    if (!confirm(`Stop managing ${container.container_name}? (The container itself is not touched.)`)) return;
    try { await api.removeContainer(container.id); onSaved(); } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal title={`Access — ${container.display_name}`} onClose={onClose} wide>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="form-grid">
        <label>Display name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Description<input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      </div>
      <h2>Discord access</h2>
      <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
        View = see it in <span className="mono">/status</span>. Start/Stop/Restart = also <span className="mono">/control start|stop|restart</span>, those three actions only — rebuilds and pulls need a script command.
        Members with no grant on any container don't see the commands at all.
        Discord admins (Administrator permission, the server owner, or a Warden admin role) always have full access. Logs are web-only.
      </p>
      <GrantEditor grants={grants as any} onChange={(g) => setGrants(g as any)} meta={meta} flags={FLAGS} defaultFlags={{ can_view: true }} />
      <hr className="divider" />
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <button className="btn btn-danger-outline" onClick={remove}>Remove from StormWarden</button>
        <div className="btn-row">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

function LogsModal({ container, onClose }: { container: ManagedContainer; onClose: () => void }) {
  const [logs, setLogs] = useState('Loading…');
  const [tail, setTail] = useState(200);
  useEffect(() => { api.containerLogs(container.id, tail).then((r) => setLogs(r.logs || '(no output)')).catch((e) => setLogs(e.message)); }, [container.id, tail]);
  return (
    <Modal title={`Logs — ${container.display_name}`} onClose={onClose} wide>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        {[100, 200, 500, 1000].map((n) => <button key={n} className={`chip${tail === n ? ' chip-on' : ''}`} onClick={() => setTail(n)}>{n} lines</button>)}
      </div>
      <pre className="console console-tall">{logs}</pre>
    </Modal>
  );
}
