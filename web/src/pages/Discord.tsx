import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BotStatus, Settings } from '../types';
import { useGuildMeta } from '../useGuildMeta';

export default function Discord() {
  const { meta, refresh } = useGuildMeta();
  const [s, setS] = useState<Settings | null>(null);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.getSettings().then((r) => { setS(r.settings); setStatus(r.discord); }); }, []);
  if (!s) return <p className="muted">Loading…</p>;
  const set = (k: keyof Settings, v: unknown) => setS({ ...s, [k]: v } as Settings);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.saveSettings({
        discord_enabled: s.discord_enabled, discord_bot_token: token, discord_guild_id: s.discord_guild_id,
        discord_admin_role_ids: s.discord_admin_role_ids, discord_log_channel_id: s.discord_log_channel_id,
      });
      setS(r.settings); setStatus(r.discord); setToken('');
      setMsg(r.discord.error ? { kind: 'error', text: r.discord.error } : { kind: 'ok', text: 'Saved.' });
      refresh();
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  };
  const restart = async () => {
    setBusy(true);
    try { const r = await api.restartBot(); setStatus(r.discord); refresh(); } finally { setBusy(false); }
  };
  const toggleAdminRole = (id: string) =>
    set('discord_admin_role_ids', s.discord_admin_role_ids.includes(id) ? s.discord_admin_role_ids.filter((x) => x !== id) : [...s.discord_admin_role_ids, id]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Discord Bot</h1>
          <span className="muted">
            Status: {status?.running ? <span className="pill-ok">online{meta.guildName ? ` in ${meta.guildName}` : ''}</span> : <span className="pill-bad">offline</span>}
          </span>
        </div>
        <button className="btn" onClick={restart} disabled={busy}>Restart bot</button>
      </div>
      {status?.error && <div className="alert alert-error">{status.error}</div>}
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}

      <div className="card">
        <h2>Connection</h2>
        <label className="checkbox-label"><input type="checkbox" checked={s.discord_enabled} onChange={(e) => set('discord_enabled', e.target.checked)} /> Bot enabled</label>
        <div className="form-grid">
          <label>Bot token
            <input type="password" value={token} placeholder={s.discord_bot_token_set ? '•••••• (saved — leave blank to keep)' : 'Paste bot token'} onChange={(e) => setToken(e.target.value)} />
          </label>
          <label>Server (guild) ID
            <input className="mono" value={s.discord_guild_id} onChange={(e) => set('discord_guild_id', e.target.value.trim())} />
          </label>
        </div>
        <p className="hint">
          Use a separate bot application from Stormsmith so the two bots' slash commands never collide. In the Developer Portal enable the
          <strong> Message Content Intent</strong> (needed for request-thread sync). Invite scopes: <span className="mono">bot applications.commands</span>;
          permissions: Send Messages, Embed Links, Attach Files, Add Reactions, Create Public Threads, Send Messages in Threads, Manage Threads.
        </p>
      </div>

      <div className="card">
        <h2>Warden admins</h2>
        <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
          Members with these roles (plus anyone with Discord's Administrator permission) can use every container and script, regardless of grants.
        </p>
        <div className="chip-list">
          {meta.roles.length === 0 && <span className="muted">Start the bot to load roles.</span>}
          {meta.roles.map((r) => (
            <button key={r.id} className={`chip${s.discord_admin_role_ids.includes(r.id) ? ' chip-on' : ''}`} onClick={() => toggleAdminRole(r.id)}>@{r.name}</button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Activity log channel</h2>
        <label>Post a line here for every script run and container action (optional)
          <select value={s.discord_log_channel_id} onChange={(e) => set('discord_log_channel_id', e.target.value)}>
            <option value="">— none —</option>
            {meta.channels.filter((c) => c.type !== 'forum').map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </label>
      </div>

      <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Commands members get</h2>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li><span className="mono">/docker status [container]</span> · <span className="mono">start</span> · <span className="mono">stop</span> · <span className="mono">restart</span> — filtered to containers they're granted (logs stay web-only)</li>
          <li><span className="mono">/request &lt;project&gt;</span> — opens a form, files a Vikunja task, starts a synced thread</li>
          <li>One command per enabled script, e.g. <span className="mono">/updatefrostgate</span></li>
        </ul>
      </div>
    </div>
  );
}
