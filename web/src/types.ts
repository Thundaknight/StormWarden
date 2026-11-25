export interface User { id: number; username: string; role: 'admin'; created_at?: string; discord_id?: string; discord_username?: string }

export type SubjectType = 'role' | 'user';
export interface SubjectRef { subject_type: SubjectType; subject_id: string; subject_name: string }
export interface ContainerGrant extends SubjectRef { can_view: number | boolean; can_control: number | boolean; can_logs: number | boolean }

export type ContainerState = 'running' | 'paused' | 'restarting' | 'exited' | 'created' | 'dead' | 'removing' | 'not_found';

export interface ManagedContainer {
  id: number; container_name: string; display_name: string; description: string;
  state: ContainerState; status: string; image: string; compose_project: string; compose_working_dir: string;
  grants: ContainerGrant[];
  protected: 'self' | 'stormsmith' | null;
}

export interface HostContainer {
  name: string; image: string; state: ContainerState; status: string; composeProject: string; composeWorkingDir: string; managed: boolean;
  protected: 'self' | 'stormsmith' | null;
}

export type RunStatus = 'running' | 'success' | 'failed' | 'timeout' | 'error';
export interface RunSummary {
  id: number; script_id: number | null; command_name: string; triggered_by: string; source: 'discord' | 'web';
  status: RunStatus; exit_code: number | null; started_at: string; finished_at: string | null;
}
export interface Run extends RunSummary { output: string }

export interface Script {
  id: number; command_name: string; description: string; container_id: number | null; working_dir: string; body: string;
  timeout_sec: number; require_confirm: number; ephemeral_output: number; enabled: number;
  grants: SubjectRef[]; last_run: RunSummary | null; running: boolean; options: ScriptOption[];
}
export interface ScriptOption { name: string; description: string; required: boolean; choices: Array<{ label: string; value: string }> }

export interface Settings {
  discord_enabled: boolean; discord_bot_token: string; discord_bot_token_set: boolean; discord_client_id: string;
  discord_guild_id: string; discord_admin_role_ids: string[]; discord_log_channel_id: string;
  vikunja_url: string; vikunja_token: string; vikunja_token_set: boolean; vikunja_sync_enabled: boolean;
  web_base_url: string; discord_client_secret: string; discord_client_secret_set: boolean; discord_oauth_enabled: boolean;
  password_login_disabled: boolean; discord_failure_ping: { type: 'role' | 'user'; id: string; name: string } | null;
  stormsmith_db_path: string; discord_perm_token: { username: string } | null; oauth_redirect_uri: string;
}
export interface BotStatus { running: boolean; error: string; permSync?: { ok: boolean; message: string; at: string } }

export interface GuildMeta {
  guildName: string;
  roles: Array<{ id: string; name: string; color: string }>;
  channels: Array<{ id: string; name: string; type: 'text' | 'forum' | 'announcement' }>;
  error?: string;
}

export interface ProjectMap {
  id: number; key: string; display_name: string; vikunja_project_id: number; channel_id: string; enabled: number; grants: SubjectRef[];
  container_id: number | null; label_ids: number[];
}
export interface VikunjaLabel { id: number; title: string; hex_color?: string }
export interface VikunjaProject { id: number; title: string }
export interface FeatureRequest {
  id: number; project_name: string; vikunja_task_id: number; thread_id: string; requester_name: string; title: string;
  done: number; created_at: string; task_url: string;
}
export interface AuditEntry { id: number; at: string; actor: string; source: string; action: string; target: string; detail: string }
