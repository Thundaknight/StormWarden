import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { RunSummary, Script } from '../types';
import { fmtTime } from '../format';

export default function Scripts() {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState('');
  const nav = useNavigate();

  useEffect(() => {
    const load = () => {
      api.listScripts().then((r) => setScripts(r.scripts)).catch((e) => setError(e.message));
      api.listRuns(undefined, 25).then((r) => setRuns(r.runs)).catch(() => {});
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Scripts</h1>
          <span className="muted">Each script becomes its own Discord slash command.</span>
        </div>
        <Link className="btn btn-primary" to="/scripts/new">+ New script</Link>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="card">
        {scripts.length === 0 ? (
          <p className="muted empty-state">No scripts yet. Create one — e.g. <span className="cmd-name">/updatefrostgate</span> that runs <span className="mono">git pull</span> and rebuilds the stack.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Command</th><th>Description</th><th>Who can run</th><th>Last run</th><th /></tr></thead>
            <tbody>
              {scripts.map((s) => (
                <tr key={s.id} className="row-clickable" onClick={() => nav(`/scripts/${s.id}`)}>
                  <td><span className="cmd-name">/{s.command_name}</span>{!s.enabled && <span className="muted"> (disabled)</span>}</td>
                  <td className="muted">{s.description}</td>
                  <td>{s.grants.length ? s.grants.map((g) => (g.subject_type === 'role' ? '@' : '👤') + (g.subject_name || g.subject_id)).join(', ') : <span className="muted">admins only</span>}</td>
                  <td>
                    {s.running ? <span className="run-status run-running">running</span>
                      : s.last_run ? <><span className={`run-status run-${s.last_run.status}`}>{s.last_run.status}</span> <span className="muted">{fmtTime(s.last_run.started_at)}</span></>
                        : <span className="muted">never</span>}
                  </td>
                  <td className="table-actions"><Link className="btn btn-small" to={`/scripts/${s.id}`} onClick={(e) => e.stopPropagation()}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Recent runs</h2>
        <RunTable runs={runs} />
      </div>
    </div>
  );
}

export function RunTable({ runs, onOpen }: { runs: RunSummary[]; onOpen?: (id: number) => void }) {
  const nav = useNavigate();
  if (!runs.length) return <p className="muted">No runs yet.</p>;
  return (
    <table className="table">
      <thead><tr><th>#</th><th>Command</th><th>Status</th><th>By</th><th>Started</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className="row-clickable" onClick={() => (onOpen ? onOpen(r.id) : r.script_id && nav(`/scripts/${r.script_id}?run=${r.id}`))}>
            <td className="mono">{r.id}</td>
            <td><span className="cmd-name">/{r.command_name}</span></td>
            <td><span className={`run-status run-${r.status}`}>{r.status}</span>{r.exit_code !== null && <span className="muted"> ({r.exit_code})</span>}</td>
            <td>{r.triggered_by} <span className="muted">via {r.source}</span></td>
            <td className="muted">{fmtTime(r.started_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
