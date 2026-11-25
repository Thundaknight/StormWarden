import Database from 'better-sqlite3';
import { config } from './config';
import type {
  AuditEntry, ContainerGrant, FeatureRequest, ManagedContainer, RunStatus, Script, ScriptRun, SubjectRef,
  SubjectType, User, VikunjaProjectMap,
} from './types';

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS containers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS container_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      subject_name TEXT NOT NULL DEFAULT '',
      can_view INTEGER NOT NULL DEFAULT 1,
      can_control INTEGER NOT NULL DEFAULT 0,
      can_logs INTEGER NOT NULL DEFAULT 0,
      UNIQUE (container_id, subject_type, subject_id)
    );

    CREATE TABLE IF NOT EXISTS scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      container_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
      working_dir TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      timeout_sec INTEGER NOT NULL DEFAULT 600,
      require_confirm INTEGER NOT NULL DEFAULT 1,
      ephemeral_output INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS script_grants (
      script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      subject_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (script_id, subject_type, subject_id)
    );

    CREATE TABLE IF NOT EXISTS script_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id INTEGER REFERENCES scripts(id) ON DELETE SET NULL,
      command_name TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      triggered_by_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      output TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_script ON script_runs(script_id, id DESC);

    CREATE TABLE IF NOT EXISTS vikunja_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      vikunja_project_id INTEGER NOT NULL,
      channel_id TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS vikunja_project_grants (
      project_map_id INTEGER NOT NULL REFERENCES vikunja_projects(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      subject_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (project_map_id, subject_type, subject_id)
    );

    CREATE TABLE IF NOT EXISTS feature_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_map_id INTEGER NOT NULL REFERENCES vikunja_projects(id) ON DELETE CASCADE,
      vikunja_task_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      requester_id TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_requests_thread ON feature_requests(thread_id);

    -- Every Vikunja comment we've already mirrored (either direction), so polling never echoes.
    CREATE TABLE IF NOT EXISTS synced_comments (
      vikunja_comment_id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
      discord_message_id TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      actor TEXT NOT NULL,
      source TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT ''
    );
  `);

  // A run left 'running' means the process died mid-run (container restart). Close it out.
  db.prepare(`UPDATE script_runs SET status = 'error', finished_at = datetime('now'),
    output = output || '\n[StormWarden restarted while this run was in progress]'
    WHERE status = 'running'`).run();
}

// ---------- settings ----------

export interface Settings {
  discord_enabled: boolean;
  discord_bot_token: string;
  discord_client_id: string;
  discord_guild_id: string;
  /** Discord role ids whose members bypass all grants (StormWarden admins in Discord). */
  discord_admin_role_ids: string[];
  /** Channel that receives a post for every script run / container action (optional). */
  discord_log_channel_id: string;
  vikunja_url: string;
  vikunja_token: string;
  vikunja_sync_enabled: boolean;
}

const SETTING_DEFAULTS: Settings = {
  discord_enabled: false,
  discord_bot_token: '',
  discord_client_id: '',
  discord_guild_id: '',
  discord_admin_role_ids: [],
  discord_log_channel_id: '',
  vikunja_url: '',
  vikunja_token: '',
  vikunja_sync_enabled: true,
};

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const out: any = { ...SETTING_DEFAULTS };
  for (const r of rows) {
    if (!(r.key in SETTING_DEFAULTS)) continue;
    try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ }
  }
  return out as Settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in SETTING_DEFAULTS) || v === undefined) continue;
      stmt.run(k, JSON.stringify(v));
    }
  });
  tx();
  return getSettings();
}

// ---------- users ----------

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}
export function getUserById(id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}
export function getUserByUsername(username: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
}
export function listUsers(): Array<Omit<User, 'password_hash'>> {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all() as any;
}
export function createUser(username: string, passwordHash: string): User {
  const r = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, passwordHash, 'admin');
  return getUserById(Number(r.lastInsertRowid))!;
}
export function setUserPassword(id: number, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}
export function deleteUser(id: number): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ---------- containers + grants ----------

export function listContainers(): ManagedContainer[] {
  return db.prepare('SELECT * FROM containers ORDER BY display_name COLLATE NOCASE').all() as ManagedContainer[];
}
export function getContainer(id: number): ManagedContainer | undefined {
  return db.prepare('SELECT * FROM containers WHERE id = ?').get(id) as ManagedContainer | undefined;
}
export function addContainer(containerName: string, displayName: string, description: string): ManagedContainer {
  const r = db.prepare('INSERT INTO containers (container_name, display_name, description) VALUES (?, ?, ?)')
    .run(containerName, displayName, description);
  return getContainer(Number(r.lastInsertRowid))!;
}
export function updateContainer(id: number, displayName: string, description: string): void {
  db.prepare('UPDATE containers SET display_name = ?, description = ? WHERE id = ?').run(displayName, description, id);
}
export function deleteContainer(id: number): void {
  db.prepare('DELETE FROM containers WHERE id = ?').run(id);
}

export function listContainerGrants(containerId?: number): ContainerGrant[] {
  if (containerId === undefined) return db.prepare('SELECT * FROM container_grants').all() as ContainerGrant[];
  return db.prepare('SELECT * FROM container_grants WHERE container_id = ? ORDER BY subject_type, subject_name')
    .all(containerId) as ContainerGrant[];
}

export function setContainerGrants(
  containerId: number,
  grants: Array<SubjectRef & { can_view: boolean; can_control: boolean; can_logs: boolean }>,
): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM container_grants WHERE container_id = ?').run(containerId);
    const ins = db.prepare(`INSERT INTO container_grants
      (container_id, subject_type, subject_id, subject_name, can_view, can_control, can_logs) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const g of grants) {
      ins.run(containerId, g.subject_type, g.subject_id, g.subject_name || '',
        g.can_view || g.can_control || g.can_logs ? 1 : 0, g.can_control ? 1 : 0, g.can_logs ? 1 : 0);
    }
  });
  tx();
}

// ---------- scripts ----------

export function listScripts(): Script[] {
  return db.prepare('SELECT * FROM scripts ORDER BY command_name').all() as Script[];
}
export function getScript(id: number): Script | undefined {
  return db.prepare('SELECT * FROM scripts WHERE id = ?').get(id) as Script | undefined;
}
export function getScriptByCommand(name: string): Script | undefined {
  return db.prepare('SELECT * FROM scripts WHERE command_name = ?').get(name) as Script | undefined;
}

export type ScriptInput = Pick<Script, 'command_name' | 'description' | 'container_id' | 'working_dir' | 'body'
  | 'timeout_sec' | 'require_confirm' | 'ephemeral_output' | 'enabled'>;

export function createScript(s: ScriptInput): Script {
  const r = db.prepare(`INSERT INTO scripts
    (command_name, description, container_id, working_dir, body, timeout_sec, require_confirm, ephemeral_output, enabled)
    VALUES (@command_name, @description, @container_id, @working_dir, @body, @timeout_sec, @require_confirm, @ephemeral_output, @enabled)`)
    .run(s);
  return getScript(Number(r.lastInsertRowid))!;
}
export function updateScript(id: number, s: ScriptInput): Script {
  db.prepare(`UPDATE scripts SET command_name = @command_name, description = @description, container_id = @container_id,
    working_dir = @working_dir, body = @body, timeout_sec = @timeout_sec, require_confirm = @require_confirm,
    ephemeral_output = @ephemeral_output, enabled = @enabled, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...s, id });
  return getScript(id)!;
}
export function deleteScript(id: number): void {
  db.prepare('DELETE FROM scripts WHERE id = ?').run(id);
}

export function listScriptGrants(scriptId?: number): Array<SubjectRef & { script_id: number }> {
  if (scriptId === undefined) return db.prepare('SELECT * FROM script_grants').all() as any;
  return db.prepare('SELECT * FROM script_grants WHERE script_id = ? ORDER BY subject_type, subject_name').all(scriptId) as any;
}
export function setScriptGrants(scriptId: number, grants: SubjectRef[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM script_grants WHERE script_id = ?').run(scriptId);
    const ins = db.prepare('INSERT OR IGNORE INTO script_grants (script_id, subject_type, subject_id, subject_name) VALUES (?, ?, ?, ?)');
    for (const g of grants) ins.run(scriptId, g.subject_type, g.subject_id, g.subject_name || '');
  });
  tx();
}

// ---------- script runs ----------

export function createRun(r: Pick<ScriptRun, 'script_id' | 'command_name' | 'triggered_by' | 'triggered_by_id' | 'source'>): number {
  const res = db.prepare(`INSERT INTO script_runs (script_id, command_name, triggered_by, triggered_by_id, source)
    VALUES (@script_id, @command_name, @triggered_by, @triggered_by_id, @source)`).run(r);
  return Number(res.lastInsertRowid);
}
export function updateRunOutput(id: number, output: string): void {
  db.prepare('UPDATE script_runs SET output = ? WHERE id = ?').run(output, id);
}
export function finishRun(id: number, status: RunStatus, exitCode: number | null, output: string): void {
  db.prepare(`UPDATE script_runs SET status = ?, exit_code = ?, output = ?, finished_at = datetime('now') WHERE id = ?`)
    .run(status, exitCode, output, id);
}
export function getRun(id: number): ScriptRun | undefined {
  return db.prepare('SELECT * FROM script_runs WHERE id = ?').get(id) as ScriptRun | undefined;
}
export function listRuns(opts: { scriptId?: number; limit?: number } = {}): Array<Omit<ScriptRun, 'output'>> {
  const limit = Math.min(Math.max(opts.limit || 50, 1), 500);
  const cols = 'id, script_id, command_name, triggered_by, triggered_by_id, source, status, exit_code, started_at, finished_at';
  if (opts.scriptId) {
    return db.prepare(`SELECT ${cols} FROM script_runs WHERE script_id = ? ORDER BY id DESC LIMIT ?`).all(opts.scriptId, limit) as any;
  }
  return db.prepare(`SELECT ${cols} FROM script_runs ORDER BY id DESC LIMIT ?`).all(limit) as any;
}

// ---------- vikunja project mappings ----------

export function listProjectMaps(): VikunjaProjectMap[] {
  return db.prepare('SELECT * FROM vikunja_projects ORDER BY display_name COLLATE NOCASE').all() as VikunjaProjectMap[];
}
export function getProjectMap(id: number): VikunjaProjectMap | undefined {
  return db.prepare('SELECT * FROM vikunja_projects WHERE id = ?').get(id) as VikunjaProjectMap | undefined;
}
export function getProjectMapByKey(key: string): VikunjaProjectMap | undefined {
  return db.prepare('SELECT * FROM vikunja_projects WHERE key = ?').get(key) as VikunjaProjectMap | undefined;
}
export type ProjectMapInput = Pick<VikunjaProjectMap, 'key' | 'display_name' | 'vikunja_project_id' | 'channel_id' | 'enabled'>;
export function createProjectMap(p: ProjectMapInput): VikunjaProjectMap {
  const r = db.prepare(`INSERT INTO vikunja_projects (key, display_name, vikunja_project_id, channel_id, enabled)
    VALUES (@key, @display_name, @vikunja_project_id, @channel_id, @enabled)`).run(p);
  return getProjectMap(Number(r.lastInsertRowid))!;
}
export function updateProjectMap(id: number, p: ProjectMapInput): VikunjaProjectMap {
  db.prepare(`UPDATE vikunja_projects SET key = @key, display_name = @display_name, vikunja_project_id = @vikunja_project_id,
    channel_id = @channel_id, enabled = @enabled WHERE id = @id`).run({ ...p, id });
  return getProjectMap(id)!;
}
export function deleteProjectMap(id: number): void {
  db.prepare('DELETE FROM vikunja_projects WHERE id = ?').run(id);
}
export function listProjectGrants(projectMapId?: number): Array<SubjectRef & { project_map_id: number }> {
  if (projectMapId === undefined) return db.prepare('SELECT * FROM vikunja_project_grants').all() as any;
  return db.prepare('SELECT * FROM vikunja_project_grants WHERE project_map_id = ?').all(projectMapId) as any;
}
export function setProjectGrants(projectMapId: number, grants: SubjectRef[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM vikunja_project_grants WHERE project_map_id = ?').run(projectMapId);
    const ins = db.prepare('INSERT OR IGNORE INTO vikunja_project_grants (project_map_id, subject_type, subject_id, subject_name) VALUES (?, ?, ?, ?)');
    for (const g of grants) ins.run(projectMapId, g.subject_type, g.subject_id, g.subject_name || '');
  });
  tx();
}

// ---------- feature requests ----------

export function createRequest(r: Omit<FeatureRequest, 'id' | 'done' | 'created_at'>): FeatureRequest {
  const res = db.prepare(`INSERT INTO feature_requests (project_map_id, vikunja_task_id, thread_id, requester_id, requester_name, title)
    VALUES (@project_map_id, @vikunja_task_id, @thread_id, @requester_id, @requester_name, @title)`).run(r);
  return db.prepare('SELECT * FROM feature_requests WHERE id = ?').get(Number(res.lastInsertRowid)) as FeatureRequest;
}
export function setRequestThread(id: number, threadId: string): void {
  db.prepare('UPDATE feature_requests SET thread_id = ? WHERE id = ?').run(threadId, id);
}
export function setRequestDone(id: number, done: boolean): void {
  db.prepare('UPDATE feature_requests SET done = ? WHERE id = ?').run(done ? 1 : 0, id);
}
export function getRequestByThread(threadId: string): FeatureRequest | undefined {
  return db.prepare('SELECT * FROM feature_requests WHERE thread_id = ?').get(threadId) as FeatureRequest | undefined;
}
export function listOpenSyncedRequests(): FeatureRequest[] {
  return db.prepare(`SELECT * FROM feature_requests WHERE done = 0 AND thread_id != '' ORDER BY id`).all() as FeatureRequest[];
}
export function listRequests(limit = 100): Array<FeatureRequest & { project_name: string }> {
  return db.prepare(`SELECT r.*, p.display_name AS project_name FROM feature_requests r
    JOIN vikunja_projects p ON p.id = r.project_map_id ORDER BY r.id DESC LIMIT ?`).all(limit) as any;
}
export function isCommentSynced(commentId: number): boolean {
  return !!db.prepare('SELECT 1 FROM synced_comments WHERE vikunja_comment_id = ?').get(commentId);
}
export function markCommentSynced(commentId: number, requestId: number, discordMessageId: string, direction: 'to_discord' | 'to_vikunja'): void {
  db.prepare(`INSERT OR IGNORE INTO synced_comments (vikunja_comment_id, request_id, discord_message_id, direction)
    VALUES (?, ?, ?, ?)`).run(commentId, requestId, discordMessageId, direction);
}

// ---------- audit ----------

export function audit(actor: string, source: AuditEntry['source'], action: string, target = '', detail = ''): void {
  db.prepare('INSERT INTO audit_log (actor, source, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(actor, source, action, target, detail);
}
export function listAudit(opts: { before?: number; limit?: number } = {}): AuditEntry[] {
  const limit = Math.min(Math.max(opts.limit || 100, 1), 500);
  if (opts.before) {
    return db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(opts.before, limit) as AuditEntry[];
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as AuditEntry[];
}

export function isSubjectType(v: unknown): v is SubjectType {
  return v === 'role' || v === 'user';
}
