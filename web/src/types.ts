export interface User { id: number; username: string; role: 'admin'; created_at?: string }

export type SubjectType = 'role' | 'user';
export interface SubjectRef { subject_type: SubjectType; subject_id: string; subject_name: string }
export interface ContainerGrant extends SubjectRef { can_view: number | boolean; can_control: number | boolean; can_logs: number | boolean }

export type ContainerState = 'running' | 'paused' | 'restarting' | 'exited' | 'created' | 'dead' | 'removing' | 'not_found';

export interface ManagedContainer {
  id: number; container_name: string; display_name: string; description: string;
  state: ContainerState; status: string; image: string; compose_project: string; compose_working_dir: string;
  grants: ContainerGrant[];
}

export interface HostContainer {
  name: string; image: string; state: ContainerState; status: string; composeProject: string; composeWorkingDir: string; managed: boolean;
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
  grants: SubjectRef[]; last_run: RunSummary | null; running: boolean;
}

export interface Settings {
  discord_enabled: boolean; discord_bot_token: string; discord_bot_token_set: boolean; discord_client_id: string;
  discord_guild_id: string; discord_admin_role_ids: string[]; discord_log_channel_id: string;
  vikunja_url: string; vikunja_token: string; vikunja_token_set: boolean; vikunja_sync_enabled: boolean;
}
export interface BotStatus { running: boolean; error: string }

export interface GuildMeta {
  guildName: string;
  roles: Array<{ id: string; name: string; color: string }>;
  channels: Array<{ id: string; name: string; type: 'text' | 'forum' | 'announcement' }>;
  error?: string;
}

export interface ProjectMap {
  id: number; key: string; display_name: string; vikunja_project_id: number; channel_id: string; enabled: number; grants: SubjectRef[];
}
export interface VikunjaProject { id: number; title: string }
export interface FeatureRequest {
  id: number; project_name: string; vikunja_task_id: number; thread_id: string; requester_name: string; title: string;
  done: number; created_at: string; task_url: string;
}
export interface AuditEntry { id: number; at: string; actor: string; source: string; action: string; target: string; detail: string }
