import { Router } from 'express';
import { hashPassword, requireAuth, signToken, verifyPassword, verifyToken } from '../auth';
import { config } from '../config';
import {
  audit, countDiscordLinkedUsers, countUsers, createUser, getSettings, getUserByDiscordId, getUserById, getUserByUsername,
  setUserDiscord, updateSettings,
} from '../db';
import { discordBot } from '../discord/bot';
import {
  buildAuthorizeUrl, exchangeCode, fetchIdentity, oauthReady, savePermToken, signOAuthState, verifyOAuthState,
  type OAuthPurpose,
} from '../discordOAuth';
import { asyncRoute } from './helpers';

const router = Router();

router.get('/status', (_req, res) => {
  const s = getSettings();
  res.json({
    needsSetup: countUsers() === 0,
    discordLogin: s.discord_oauth_enabled && oauthReady().ok,
    passwordLogin: !passwordLoginOff(),
    version: config.version,
  });
});

/** First run only: the very first account becomes the owner/admin. */
router.post('/setup', (req, res) => {
  if (countUsers() > 0) return void res.status(403).json({ error: 'Setup has already been completed' });
  const { username, password } = req.body || {};
  if (!username || !password || String(password).length < 8) {
    return void res.status(400).json({ error: 'Username and a password of at least 8 characters are required' });
  }
  const user = createUser(String(username).trim(), hashPassword(String(password)));
  res.json({ token: signToken(user), user: { id: user.id, username: user.username, role: user.role } });
});

/** ALLOW_PASSWORD_LOGIN=1 is the break-glass switch if Discord sign-in ever stops working. */
function passwordLoginOff(): boolean {
  return getSettings().password_login_disabled && countUsers() > 0 && process.env.ALLOW_PASSWORD_LOGIN !== '1';
}

router.post('/login', (req, res) => {
  if (passwordLoginOff()) {
    return void res.status(403).json({ error: 'Password sign-in is turned off. Sign in with Discord.' });
  }
  const { username, password } = req.body || {};
  const user = username ? getUserByUsername(String(username)) : undefined;
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return void res.status(401).json({ error: 'Invalid username or password' });
  }
  res.json({ token: signToken(user), user: { id: user.id, username: user.username, role: user.role } });
});

router.get('/me', requireAuth, (req, res) => {
  const u = getUserById(req.user!.userId)!;
  res.json({ user: { ...req.user, discord_username: u.discord_username } });
});

/** Turn password sign-in on/off. Refuses to lock everyone out. */
router.post('/password-login', requireAuth, (req, res) => {
  const disable = !!req.body?.disabled;
  if (disable) {
    const s = getSettings();
    if (!s.discord_oauth_enabled || !oauthReady().ok) return void res.status(400).json({ error: 'Enable Discord sign-in first.' });
    if (!getUserById(req.user!.userId)?.discord_id) return void res.status(400).json({ error: 'Link your own Discord account first.' });
    if (countDiscordLinkedUsers() === 0) return void res.status(400).json({ error: 'No account has Discord linked.' });
  }
  updateSettings({ password_login_disabled: disable });
  audit(req.user!.username, 'web', disable ? 'auth.password-login.off' : 'auth.password-login.on');
  res.json({ ok: true });
});

// ---- Discord OAuth ----

function start(purpose: OAuthPurpose) {
  return (req: any, res: any) => {
    const ready = oauthReady();
    if (!ready.ok) return void res.status(400).send(`Discord sign-in is not configured: ${ready.reason}.`);
    if (purpose === 'login') {
      if (!getSettings().discord_oauth_enabled) return void res.status(400).send('Discord sign-in is turned off.');
      return void res.redirect(buildAuthorizeUrl('login', signOAuthState({ purpose: 'login' })));
    }
    // Top-level navigations can't carry an Authorization header, so the web token comes as ?token=
    const payload = verifyToken(String(req.query.token || ''));
    if (!payload) return void res.status(401).send('Your session expired — sign in again and retry.');
    res.redirect(buildAuthorizeUrl(purpose, signOAuthState({ purpose, userId: payload.userId })));
  };
}
router.get('/discord/login', start('login'));
router.get('/discord/link', start('link'));
router.get('/discord/perms', start('perms'));

router.get('/discord/callback', asyncRoute(async (req, res) => {
  const back = (path: string, params: Record<string, string>) => res.redirect(`${path}?${new URLSearchParams(params)}`);
  const code = String(req.query.code || '');
  const state = code ? verifyOAuthState(String(req.query.state || '')) : null;
  if (!state) return back('/', { discordError: 'Discord sign-in expired or was cancelled. Please try again.' });

  let tokens;
  let identity;
  try {
    tokens = await exchangeCode(code);
    identity = await fetchIdentity(tokens.access_token);
  } catch (err: any) {
    return back('/', { discordError: err?.message || String(err) });
  }
  const label = identity.global_name || identity.username;

  if (state.purpose === 'login') {
    const user = getUserByDiscordId(identity.id);
    if (!user) {
      audit(identity.username, 'web', 'auth.discord.rejected', identity.id);
      return back('/', { discordError: 'That Discord account is not linked to a StormWarden user.' });
    }
    audit(user.username, 'web', 'auth.discord.login');
    return back('/', { discordToken: signToken(user) });
  }

  const user = getUserById(state.userId);
  if (!user) return back('/', { discordError: 'Account not found.' });

  if (state.purpose === 'link') {
    const other = getUserByDiscordId(identity.id);
    if (other && other.id !== user.id) return back('/users', { discordError: 'That Discord account is linked to another user.' });
    setUserDiscord(user.id, identity.id, label);
    audit(user.username, 'web', 'auth.discord.link', label);
    return back('/users', { discordLinked: '1' });
  }

  // perms
  if (!tokens.scope.includes('applications.commands.permissions.update')) {
    return back('/discord', { discordError: 'Discord did not grant the command-permissions scope.' });
  }
  savePermToken(tokens, label);
  audit(user.username, 'web', 'discord.perm-sync.authorized', label);
  discordBot.queueCommandRefresh();
  return back('/discord', { permsLinked: '1' });
}));

router.post('/discord/unlink', requireAuth, (req, res) => {
  const user = getUserById(req.user!.userId)!;
  if (getSettings().password_login_disabled && countDiscordLinkedUsers() <= 1) {
    return void res.status(400).json({ error: 'Password sign-in is off and this is the last linked account — you would be locked out.' });
  }
  setUserDiscord(user.id, '', '');
  audit(user.username, 'web', 'auth.discord.unlink');
  res.json({ ok: true });
});

export default router;
