import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from './config';
import { getSettings } from './db';
import { docker } from './docker';

/**
 * Containers StormWarden must never touch:
 *  - itself (no self-restart / self-update — a restart would kill the bot mid-reply and a rebuild
 *    would kill the script doing it), and
 *  - every container Stormsmith manages (game servers belong to Stormsmith).
 */

let selfName: string | null | undefined;

/** Our own container's name. Docker sets the hostname to the short container id by default. */
export async function getSelfContainerName(): Promise<string | null> {
  if (selfName !== undefined) return selfName;
  if (process.env.STORMWARDEN_CONTAINER) return (selfName = process.env.STORMWARDEN_CONTAINER);
  try {
    const host = os.hostname();
    const list = await docker.listContainers({ all: true });
    const me = list.find((c) => c.Id.startsWith(host) || c.Names.some((n) => n.replace(/^\//, '') === host));
    selfName = me ? me.Names[0].replace(/^\//, '') : null;
  } catch {
    return null; // Docker unreachable: don't cache, try again next time
  }
  return selfName;
}

let ssCache: { at: number; names: Set<string>; error: string } = { at: 0, names: new Set(), error: '' };

/**
 * Reads container names from Stormsmith's SQLite DB. The live file is in WAL mode and may be on a
 * read-only mount, so we copy db+wal to a temp dir and read the copy — never touching Stormsmith's file.
 */
export function getStormsmithContainers(): { names: Set<string>; error: string } {
  if (Date.now() - ssCache.at < 30_000) return ssCache;
  const src = getSettings().stormsmith_db_path.trim();
  if (!src) {
    ssCache = { at: Date.now(), names: new Set(), error: '' };
    return ssCache;
  }
  const tmp = path.join(os.tmpdir(), 'sw-stormsmith');
  try {
    if (!fs.existsSync(src)) throw new Error(`${src} not found (mount Stormsmith's appdata into StormWarden)`);
    fs.mkdirSync(tmp, { recursive: true });
    const dst = path.join(tmp, 'stormsmith.db');
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dst + suffix, { force: true });
    fs.copyFileSync(src, dst);
    if (fs.existsSync(src + '-wal')) fs.copyFileSync(src + '-wal', dst + '-wal');
    const sdb = new Database(dst);
    try {
      const rows = sdb.prepare('SELECT container_name FROM servers').all() as Array<{ container_name: string }>;
      ssCache = { at: Date.now(), names: new Set(rows.map((r) => r.container_name)), error: '' };
    } finally {
      sdb.close();
    }
  } catch (err: any) {
    // Keep the last known list on error so a hiccup never "unlocks" a game server.
    ssCache = { at: Date.now(), names: ssCache.names, error: err?.message || String(err) };
  }
  return ssCache;
}

export type ProtectedReason = 'self' | 'stormsmith' | null;

export async function protectedReason(containerName: string): Promise<ProtectedReason> {
  if (containerName === (await getSelfContainerName())) return 'self';
  if (getStormsmithContainers().names.has(containerName)) return 'stormsmith';
  return null;
}

export function protectedMessage(reason: ProtectedReason, name: string): string {
  if (reason === 'self') return `${name} is StormWarden itself — it can't restart or update itself.`;
  if (reason === 'stormsmith') return `${name} is managed by Stormsmith — use Stormsmith for game servers.`;
  return '';
}

/** Throws if the container is off-limits. Called by every container action path. */
export async function assertNotProtected(containerName: string): Promise<void> {
  const reason = await protectedReason(containerName);
  if (reason) throw Object.assign(new Error(protectedMessage(reason, containerName)), { statusCode: 403 });
}

