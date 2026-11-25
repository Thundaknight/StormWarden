import { useEffect, useState } from 'react';
import { api, getToken } from '../api';
import type { BotStatus, Settings } from '../types';
import { useGuildMeta } from '../useGuildMeta';
import { fmtTime } from '../format';

export default function Discord() {
  const { meta, refresh } = useGuildMeta();
  const [s, setS] = useState<Settings | null>(null);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pingQuery, setPingQuery] = useState('');
  const [pingResults, setPingResults] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    api.getSettings().then((r) => { setS(r.settings); setStatus(r.discord); });
    const q = new URLSearchParams(window.location.search);
    if (q.get('permsLinked')) setMsg({ kind: 'ok', text: 'Authorised — script command visibility will sync now.' });
    if (q.get('discordError')) setMsg({ kind: 'error', text: q.get('discordError')! });
    if (q.toString()) window.history.replaceState({}, '', window.location.pathname);
  }, []);
  if (!s) return <p className="muted">Loading…</p>;
  const set = (k: keyof Settings, v: unknown) => setS({ ...s, [k]: v } as Settings);

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.saveSettings({
        discord_enabled: s.discord_enabled, discord_bot_token: token, discord_guild_id: s.discord_guild_id,
        discord_admin_role_ids: s.discord_admin_role_ids, discord_log_channel_id: s.discord_log_channel_id,
        discord_client_id: s.discord_client_id, discord_client_secret: secret, web_base_url: s.web_base_url,
        discord_oauth_enabled: s.discord_oauth_enabled, discord_failure_ping: s.discord_failure_ping,
        ...extra,
      });
      setS(r.settings); setStatus(r.discord); setToken(''); setSecret('');
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
  const findPing = async () => {
    const r = await api.searchMembers(pingQuery.trim());
    setPingResults(r.members.length ? r.members : /^\d{15,22}$/.test(pingQuery.trim()) ? [{ id: pingQuery.trim(), name: `User ${pingQuery.trim()}` }] : []);
  };
  const oauthReady = !!(s.discord_client_id && s.discord_client_secret_set && s.web_base_url);

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
        <h2>Bot connection</h2>
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
          Use a separate bot application from Stormsmith. In the Developer Portal enable the <strong>Message Content Intent</strong> (request-thread sync).
          Invite scopes: <span className="mono">bot applications.commands</span>; permissions: Send Messages, Embed Links, Attach Files, Add Reactions,
          Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads.
        </p>
      </div>

      <div className="card">
        <h2>Warden admins</h2>
        <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
          Members with these roles (plus anyone with Discord's Administrator permission) can use every container, script and request project, and triage requests.
        </p>
        <div className="chip-list">
          {meta.roles.length === 0 && <span className="muted">Start the bot to load roles.</span>}
          {meta.roles.map((r) => (
            <button key={r.id} className={`chip${s.discord_admin_role_ids.includes(r.id) ? ' chip-on' : ''}`} onClick={() => toggleAdminRole(r.id)}>@{r.name}</button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Activity log &amp; failure alerts</h2>
        <div className="form-grid">
          <label>Log channel — a line for every script run and container action
            <select value={s.discord_log_channel_id} onChange={(e) => set('discord_log_channel_id', e.target.value)}>
              <option value="">— none —</option>
              {meta.channels.filter((c) => c.type !== 'forum').map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
          </label>
          <label>Ping on failures
            <select
              value={s.discord_failure_ping ? `${s.discord_failure_ping.type}:${s.discord_failure_ping.id}` : ''}
              onChange={(e) => {
                const [type, id] = e.target.value.split(':');
                if (!id) return set('discord_failure_ping', null);
                const name = type === 'role' ? meta.roles.find((r) => r.id === id)?.name || id : s.discord_failure_ping?.name || id;
                set('discord_failure_ping', { type, id, name });
              }}
            >
              <option value="">— nobody —</option>
              {s.discord_failure_ping?.type === 'user' && <option value={`user:${s.discord_failure_ping.id}`}>👤 {s.discord_failure_ping.name}</option>}
              {meta.roles.map((r) => <option key={r.id} value={`role:${r.id}`}>@{r.name}</option>)}
            </select>
            <span className="hint">Failed or timed-out scripts and failed container actions @-mention this role or person in the log channel.</span>
          </label>
        </div>
        <div className="grant-add-row">
          <input placeholder="…or ping a person: name or user ID" value={pingQuery} onChange={(e) => setPingQuery(e.target.value)} />
          <button className="btn btn-small" onClick={findPing} disabled={!pingQuery.trim()}>Find</button>
        </div>
        {pingResults.length > 0 && (
          <div className="chip-list" style={{ marginTop: 6 }}>
            {pingResults.map((m) => (
              <button key={m.id} className="chip" onClick={() => { set('discord_failure_ping', { type: 'user', id: m.id, name: m.name }); setPingResults([]); setPingQuery(''); }}>
                Ping {m.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Web sign-in with Discord &amp; OAuth</h2>
        <div className="form-grid">
          <label>Application (client) ID
            <input className="mono" value={s.discord_client_id} onChange={(e) => set('discord_client_id', e.target.value.trim())} />
          </label>
          <label>Client secret
            <input type="password" value={secret} placeholder={s.discord_client_secret_set ? '•••••• (saved — leave blank to keep)' : 'OAuth2 → Client secret'} onChange={(e) => setSecret(e.target.value)} />
          </label>
          <label className="span-2">Web UI address (how you open StormWarden)
            <input className="mono" value={s.web_base_url} placeholder="https://warden.local.stormconnect.ca" onChange={(e) => set('web_base_url', e.target.value.trim())} />
            {s.oauth_redirect_uri && <span className="hint">Add this redirect in Developer Portal → OAuth2 → Redirects: <span className="mono">{s.oauth_redirect_uri}</span></span>}
          </label>
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={s.discord_oauth_enabled} onChange={(e) => set('discord_oauth_enabled', e.target.checked)} /> Allow signing in to the web UI with Discord (linked accounts only — link yours on the Users page)</label>
      </div>

      <button className="btn btn-primary" onClick={() => save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Script command visibility</h2>
        <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
          Script commands are hidden from everyone except Discord admins. To show each one to exactly the roles/people you granted it,
          StormWarden needs a one-time authorisation from you (a server manager) — Discord doesn't let bots change command visibility themselves.
        </p>
        <div className="btn-row">
          {s.discord_perm_token ? (
            <>
              <span>Authorised by <strong>{s.discord_perm_token.username}</strong></span>
              <button className="btn btn-small" onClick={() => save({ discord_perm_token: null })}>Revoke</button>
            </>
          ) : (
            <button className="btn btn-discord" disabled={!oauthReady} onClick={() => { window.location.href = `/api/auth/discord/perms?token=${encodeURIComponent(getToken())}`; }}>
              Authorise visibility sync
            </button>
          )}
        </div>
        {!oauthReady && !s.discord_perm_token && <span className="hint">Fill in the application ID, client secret and web address above (and save) first.</span>}
        {status?.permSync && (
          <div className={`alert ${status.permSync.ok ? 'alert-ok' : 'alert-warn'}`} style={{ marginTop: 10, marginBottom: 0 }}>
            {status.permSync.message}{status.permSync.at && <span className="muted"> · {fmtTime(status.permSync.at)}</span>}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Commands members get</h2>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li><span className="mono">/docker status [container]</span> · <span className="mono">start</span> · <span className="mono">stop</span> · <span className="mono">restart</span> — only granted containers; never StormWarden itself or Stormsmith's game servers</li>
          <li><span className="mono">/request &lt;project&gt;</span> — only projects their role is allowed to request for</li>
          <li>One hidden command per enabled script, e.g. <span className="mono">/updatefrostgate</span>, visible to its granted roles once visibility sync is authorised</li>
        </ul>
      </div>
    </div>
  );
}
