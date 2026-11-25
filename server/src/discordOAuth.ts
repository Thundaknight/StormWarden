import jwt from 'jsonwebtoken';
import { config } from './config';
import { getSettings, updateSettings } from './db';

/**
 * Discord OAuth2 for the web UI. Three purposes, carried in a short-lived signed `state`:
 *  - login: sign in as the web user whose account is linked to this Discord id (no self-signup)
 *  - link:  attach your Discord id to your (already signed-in) web account
 *  - perms: grant StormWarden the `applications.commands.permissions.update` scope so it can control
 *           which roles see the (hidden-by-default) script commands. Bots can't do that with their
 *           own token; Discord requires a guild manager's OAuth token.
 */

export type OAuthPurpose = 'login' | 'link' | 'perms';
export type OAuthState = { purpose: 'login' } | { purpose: 'link' | 'perms'; userId: number };

export function signOAuthState(payload: OAuthState): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '10m' });
}
export function verifyOAuthState(state: string): OAuthState | null {
  try { return jwt.verify(state, config.jwtSecret) as OAuthState; } catch { return null; }
}

export function redirectUri(): string {
  return `${getSettings().web_base_url.replace(/\/+$/, '')}/api/auth/discord/callback`;
}

export function oauthReady(): { ok: boolean; reason: string } {
  const s = getSettings();
  if (!s.discord_client_id) return { ok: false, reason: 'Discord application (client) ID is not set' };
  if (!s.discord_client_secret) return { ok: false, reason: 'Discord client secret is not set' };
  if (!s.web_base_url) return { ok: false, reason: 'Web UI address is not set' };
  return { ok: true, reason: '' };
}

export function buildAuthorizeUrl(purpose: OAuthPurpose, state: string): string {
  const s = getSettings();
  const params = new URLSearchParams({
    client_id: s.discord_client_id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: purpose === 'perms' ? 'identify applications.commands.permissions.update' : 'identify',
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

interface TokenResponse { access_token: string; refresh_token: string; expires_in: number; scope: string }

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const s = getSettings();
  const res = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: s.discord_client_id, client_secret: s.discord_client_secret, ...body }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Discord token exchange failed: ${data.error_description || data.error || res.status}`);
  return data as TokenResponse;
}

export function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
}

export async function fetchIdentity(accessToken: string): Promise<{ id: string; username: string; global_name: string | null }> {
  const res = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Could not read Discord identity (HTTP ${res.status})`);
  return res.json() as any;
}

/** Stores the command-permissions token. */
export function savePermToken(t: TokenResponse, username: string): void {
  updateSettings({
    discord_perm_token: {
      access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000, username,
    },
  });
}

/** Returns a valid command-permissions access token, refreshing it if it's close to expiry. */
export async function getPermAccessToken(): Promise<string | null> {
  const tok = getSettings().discord_perm_token;
  if (!tok) return null;
  if (tok.expires_at - Date.now() > 60 * 60_000) return tok.access_token;
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token });
    savePermToken(t, tok.username);
    return t.access_token;
  } catch (err) {
    console.error('[oauth] refreshing command-permissions token failed:', (err as Error).message);
    return null;
  }
}
