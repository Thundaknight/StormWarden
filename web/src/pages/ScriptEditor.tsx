import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import GrantEditor from '../components/GrantEditor';
import type { ManagedContainer, Run, RunSummary, ScriptOption, SubjectRef } from '../types';
import Modal from '../components/Modal';
import { useGuildMeta } from '../useGuildMeta';
import { RunTable } from './Scripts';
import { fmtTime } from '../format';

const EXAMPLE = `git pull
docker compose -p frostgate up -d --build`;

export default function ScriptEditor() {
  const { id } = useParams();
  const isNew = id === 'new';
  const scriptId = isNew ? 0 : parseInt(id || '0', 10);
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { meta } = useGuildMeta();

  const [form, setForm] = useState({
    command_name: '', description: '', container_id: '' as string, working_dir: '', body: EXAMPLE,
    timeout_sec: 600, require_confirm: true, ephemeral_output: false, enabled: true,
  });
  const [grants, setGrants] = useState<SubjectRef[]>([]);
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [runPicker, setRunPicker] = useState<Record<string, string> | null>(null);
  const [containers, setContainers] = useState<ManagedContainer[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const consoleRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    api.listContainers().then((r) => setContainers(r.containers)).catch(() => {});
    if (isNew) return;
    api.getScript(scriptId).then(({ script: s }) => {
      setForm({
        command_name: s.command_name, description: s.description, container_id: s.container_id ? String(s.container_id) : '',
        working_dir: s.working_dir, body: s.body, timeout_sec: s.timeout_sec, require_confirm: !!s.require_confirm,
        ephemeral_output: !!s.ephemeral_output, enabled: !!s.enabled,
      });
      setGrants(s.grants);
      setOptions(s.options.map(toDraft));
    }).catch((e) => setError(e.message));
  }, [isNew, scriptId]);

  // Run history + live view of the selected run
  const runParam = parseInt(params.get('run') || '0', 10);
  useEffect(() => {
    if (isNew) return;
    let stop = false;
    const tick = async () => {
      api.listRuns(scriptId, 20).then((r) => !stop && setRuns(r.runs)).catch(() => {});
      if (runParam) {
        const r = await api.getRun(runParam).catch(() => null);
        if (!stop && r) setRun(r.run);
      }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(t); };
  }, [isNew, scriptId, runParam]);

  useEffect(() => { if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight; }, [run?.output]);

  const set = (k: keyof typeof form, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const onPickContainer = (cid: string) => {
    set('container_id', cid);
    const c = containers.find((x) => String(x.id) === cid);
    if (c?.compose_working_dir && !form.working_dir) set('working_dir', c.compose_working_dir);
  };

  const save = async (): Promise<number | null> => {
    setError(''); setNotice(''); setSaving(true);
    try {
      const payload: any = {
        ...form, container_id: form.container_id ? parseInt(form.container_id, 10) : null, options: options.map(fromDraft),
      };
      const r = isNew ? await api.createScript(payload) : await api.updateScript(scriptId, payload);
      await api.setScriptGrants(r.script.id, grants);
      setNotice(`Saved. /${r.script.command_name} is ${r.script.enabled ? 'registered in Discord (may take a few seconds)' : 'disabled'}.`);
      if (isNew) nav(`/scripts/${r.script.id}`, { replace: true });
      return r.script.id;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (picked: Record<string, string> = {}) => {
    const sid = await save();
    if (!sid) return;
    try {
      const r = await api.runScript(sid, picked);
      setRunPicker(null);
      setParams({ run: String(r.runId) });
    } catch (e: any) { setError(e.message); }
  };
  const startRun = () => {
    if (options.length) setRunPicker(Object.fromEntries(options.map((o) => [o.name, o.required ? fromDraft(o).choices[0]?.value || '' : ''])));
    else runNow();
  };

  const remove = async () => {
    if (!confirm(`Delete /${form.command_name}? This also removes the Discord command.`)) return;
    await api.deleteScript(scriptId);
    nav('/scripts');
  };

  return (
    <div>
      <a className="back-link" href="/scripts" onClick={(e) => { e.preventDefault(); nav('/scripts'); }}>← Scripts</a>
      <div className="page-head">
        <h1>{isNew ? 'New script' : <span className="cmd-name">/{form.command_name}</span>}</h1>
        <div className="btn-row">
          {!isNew && <button className="btn btn-danger-outline" onClick={remove}>Delete</button>}
          {!isNew && <button className="btn" onClick={startRun} disabled={saving}>Save &amp; run now</button>}
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}

      <div className="two-col">
        <div>
          <div className="card">
            <div className="form-grid">
              <label>Slash command
                <input value={form.command_name} placeholder="updatefrostgate"
                  onChange={(e) => set('command_name', e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} maxLength={32} />
                <span className="hint">Members type <span className="mono">/{form.command_name || 'name'}</span></span>
              </label>
              <label>Description (Discord, max 100)
                <input value={form.description} maxLength={100} placeholder="Pull latest Frostgate and rebuild" onChange={(e) => set('description', e.target.value)} />
              </label>
              <label>Linked container (optional)
                <select value={form.container_id} onChange={(e) => onPickContainer(e.target.value)}>
                  <option value="">— none —</option>
                  {containers.map((c) => <option key={c.id} value={c.id}>{c.display_name} ({c.container_name})</option>)}
                </select>
                <span className="hint">Exposed to the script as <span className="mono">$SW_CONTAINER</span>; fills the working dir from its compose labels.</span>
              </label>
              <label>Working directory
                <input className="mono" value={form.working_dir} placeholder="/mnt/user/appdata/repos/frostgate" onChange={(e) => set('working_dir', e.target.value)} />
                <span className="hint">Must be mounted into StormWarden at the same path as on the host.</span>
              </label>
              <label className="span-2">Script
                <textarea className="code-editor" rows={10} spellCheck={false} value={form.body} onChange={(e) => set('body', e.target.value)} />
                <span className="hint">
                  Runs with bash <span className="mono">set -e -x</span>: stops at the first failing command and echoes each command into the output.
                  Available env: <span className="mono">$SW_TRIGGERED_BY $SW_TRIGGERED_BY_ID $SW_SOURCE $SW_RUN_ID $SW_CONTAINER</span>.
                  Nothing a Discord user types is ever inserted into the script.
                </span>
              </label>
              <label>Timeout (seconds)
                <input type="number" min={5} max={3600} value={form.timeout_sec} onChange={(e) => set('timeout_sec', parseInt(e.target.value, 10) || 600)} />
              </label>
              <div>
                <label className="checkbox-label"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled (registered in Discord)</label>
                <label className="checkbox-label"><input type="checkbox" checked={form.require_confirm} onChange={(e) => set('require_confirm', e.target.checked)} /> Ask for confirmation before running</label>
                <label className="checkbox-label"><input type="checkbox" checked={form.ephemeral_output} onChange={(e) => set('ephemeral_output', e.target.checked)} /> Output visible only to the person who ran it</label>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <div className="card-head-row">
              <h2 style={{ margin: 0 }}>Options (choices)</h2>
              <button className="btn btn-small" disabled={options.length >= 5}
                onClick={() => setOptions([...options, { name: '', description: '', required: true, choicesText: '' }])}>+ Add option</button>
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Members pick from your list in Discord; the value reaches the script as <span className="mono">$SW_OPT_&lt;NAME&gt;</span>. Max 5 options, 25 choices each.
            </p>
            {options.map((o, idx) => (
              <div key={idx} className="option-card">
                <div className="form-grid">
                  <label>Name
                    <input className="mono" value={o.name} placeholder="target"
                      onChange={(e) => setOptions(options.map((x, i) => (i === idx ? { ...x, name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') } : x)))} />
                    {o.name && <span className="hint">→ <span className="mono">$SW_OPT_{o.name.toUpperCase().replace(/-/g, '_')}</span></span>}
                  </label>
                  <label>Description
                    <input value={o.description} placeholder="Which stack to rebuild"
                      onChange={(e) => setOptions(options.map((x, i) => (i === idx ? { ...x, description: e.target.value } : x)))} />
                  </label>
                  <label className="span-2">Choices — one per line, <span className="mono">Label | value</span> or just <span className="mono">value</span>
                    <textarea className="code-editor" style={{ minHeight: 80 }} rows={3} value={o.choicesText} placeholder={'Production | main\nTesting | dev'}
                      onChange={(e) => setOptions(options.map((x, i) => (i === idx ? { ...x, choicesText: e.target.value } : x)))} />
                  </label>
                </div>
                <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                  <label className="checkbox-label" style={{ margin: 0 }}>
                    <input type="checkbox" checked={o.required} onChange={(e) => setOptions(options.map((x, i) => (i === idx ? { ...x, required: e.target.checked } : x)))} /> Required
                  </label>
                  <button className="btn btn-ghost btn-small" onClick={() => setOptions(options.filter((_, i) => i !== idx))}>Remove</button>
                </div>
              </div>
            ))}
          </div>
          <div className="card">
            <h2>Who can run it in Discord</h2>
            <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>Discord admins can always run every script. Add roles or specific people for everyone else.</p>
            <GrantEditor grants={grants as any} onChange={(g) => setGrants(g as any)} meta={meta} />
          </div>
          {!isNew && (
            <div className="card">
              <h2>Run history</h2>
              <RunTable runs={runs} onOpen={(rid) => setParams({ run: String(rid) })} />
            </div>
          )}
        </div>
      </div>

      {runPicker && (
        <Modal title={`Run /${form.command_name}`} onClose={() => setRunPicker(null)}>
          {options.map((o) => (
            <label key={o.name}>{o.name}{o.required ? '' : ' (optional)'}
              <select value={runPicker[o.name] || ''} onChange={(e) => setRunPicker({ ...runPicker, [o.name]: e.target.value })}>
                {!o.required && <option value="">— none —</option>}
                {fromDraft(o).choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
          ))}
          <button className="btn btn-primary" onClick={() => runNow(runPicker)}>Run</button>
        </Modal>
      )}

      {run && (
        <div className="card">
          <div className="card-head-row">
            <h2 style={{ margin: 0 }}>
              Run #{run.id} — <span className={`run-status run-${run.status}`}>{run.status}</span>
              {run.exit_code !== null && <span className="muted"> (exit {run.exit_code})</span>}
            </h2>
            <span className="muted">{run.triggered_by} via {run.source} · {fmtTime(run.started_at)}</span>
          </div>
          <pre ref={consoleRef} className="console console-tall">{run.output || '(no output yet)'}</pre>
        </div>
      )}
    </div>
  );
}

interface OptionDraft { name: string; description: string; required: boolean; choicesText: string }

function toDraft(o: ScriptOption): OptionDraft {
  return {
    name: o.name, description: o.description, required: o.required,
    choicesText: o.choices.map((c) => (c.label === c.value ? c.value : `${c.label} | ${c.value}`)).join('\n'),
  };
}

function fromDraft(d: OptionDraft): ScriptOption {
  const choices = d.choicesText.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [label, value] = l.includes('|') ? l.split('|').map((x) => x.trim()) : [l, l];
    return { label: label || value, value: value || label };
  });
  return { name: d.name, description: d.description, required: d.required, choices };
}
