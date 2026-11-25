import { Router } from 'express';
import { requireAuth } from '../auth';
import { audit, getSettings, updateSettings, type Settings } from '../db';
import { discordBot } from '../discord/bot';

const router = Router();
router.use(requireAuth);

const SECRET_KEYS: Array<keyof Settings> = ['discord_bot_token', 'vikunja_token'];
const RESTART_KEYS: Array<keyof Settings> = ['discord_enabled', 'discord_bot_token', 'discord_guild_id', 'vikunja_sync_enabled'];

function view() {
  const s = getSettings();
  const out: any = { ...s };
  for (const k of SECRET_KEYS) {
    out[`${k}_set`] = !!s[k];
    out[k] = '';
  }
  return out;
}

router.get('/', (_req, res) => {
  res.json({ settings: view(), discord: { running: discordBot.isRunning(), error: discordBot.lastError } });
});

router.put('/', async (req, res) => {
  const before = getSettings();
  const body = req.body || {};
  const patch: Partial<Settings> = {};
  const str = (k: keyof Settings) => { if (typeof body[k] === 'string') (patch as any)[k] = body[k].trim(); };
  const bool = (k: keyof Settings) => { if (typeof body[k] === 'boolean') (patch as any)[k] = body[k]; };
  str('discord_client_id'); str('discord_guild_id'); str('discord_log_channel_id'); str('vikunja_url');
  bool('discord_enabled'); bool('vikunja_sync_enabled');
  // Secrets: empty string means "leave unchanged"; send null to clear.
  for (const k of SECRET_KEYS) {
    if (typeof body[k] === 'string' && body[k].trim()) (patch as any)[k] = body[k].trim();
    if (body[k] === null) (patch as any)[k] = '';
  }
  if (Array.isArray(body.discord_admin_role_ids)) {
    patch.discord_admin_role_ids = body.discord_admin_role_ids.map(String).filter((x: string) => /^\d{15,22}$/.test(x));
  }
  const after = updateSettings(patch);
  audit(req.user!.username, 'web', 'settings.update', '', Object.keys(patch).filter((k) => !SECRET_KEYS.includes(k as any)).join(', '));

  if (RESTART_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) {
    await discordBot.restart();
  }
  res.json({ settings: view(), discord: { running: discordBot.isRunning(), error: discordBot.lastError } });
});

router.post('/discord/restart', async (_req, res) => {
  await discordBot.restart();
  res.json({ discord: { running: discordBot.isRunning(), error: discordBot.lastError } });
});

router.get('/discord/meta', async (_req, res) => {
  try {
    res.json(await discordBot.getGuildMeta());
  } catch (err: any) {
    res.json({ guildName: '', roles: [], channels: [], error: err?.message || String(err) });
  }
});

router.get('/discord/members', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return void res.json({ members: [] });
  res.json({ members: await discordBot.lookupMember(q).catch(() => []) });
});

export default router;
