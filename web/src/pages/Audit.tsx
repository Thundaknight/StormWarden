import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AuditEntry } from '../types';
import { fmtTime } from '../format';

export default function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(true);
  useEffect(() => { api.audit().then((r) => { setEntries(r.entries); setMore(r.entries.length === 100); }); }, []);
  const loadMore = async () => {
    const last = entries[entries.length - 1];
    const r = await api.audit(last?.id);
    setEntries([...entries, ...r.entries]);
    setMore(r.entries.length === 100);
  };
  return (
    <div>
      <div className="page-head"><div><h1>Audit Log</h1><span className="muted">Who did what, from Discord and the web.</span></div></div>
      <div className="card">
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="muted">{fmtTime(e.at)}</td>
                <td>{e.actor} <span className="muted">· {e.source}</span></td>
                <td className="mono">{e.action}</td>
                <td>{e.target}</td>
                <td className="muted">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {more && entries.length > 0 && <button className="btn" style={{ marginTop: 10 }} onClick={loadMore}>Load more</button>}
      </div>
    </div>
  );
}
