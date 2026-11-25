export type UserRole = 'admin';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  discord_id: string;
  discord_username: string;
  created_at: string;
}

export interface AuthTokenPayload {
  userId: number;
  username: string;
  role: UserRole;
}

export type SubjectType = 'role' | 'user';

export interface ManagedContainer {
  id: number;
  container_name: string;
  display_name: string;
  description: string;
  created_at: string;
}

export interface ContainerGrant {
  id: number;
  container_id: number;
  subject_type: SubjectType;
  subject_id: string;
  subject_name: string;
  can_view: number;
  can_control: number;
  can_logs: number;
}

export interface Script {
  id: number;
  command_name: string;
  description: string;
  container_id: number | null;
  working_dir: string;
  body: string;
  timeout_sec: number;
  require_confirm: number;
  ephemeral_output: number;
  enabled: number;
  /** JSON ScriptOption[] */
  options_json: string;
  created_at: string;
  updated_at: string;
}

/** A Discord slash-command option whose value must be one of a fixed list. */
export interface ScriptOption {
  name: string;          // discord option name, [a-z0-9_-]{1,32}; env var SW_OPT_<NAME>
  description: string;
  required: boolean;
  choices: Array<{ label: string; value: string }>;
}

export interface SubjectRef {
  subject_type: SubjectType;
  subject_id: string;
  subject_name: string;
}

export type RunStatus = 'running' | 'success' | 'failed' | 'timeout' | 'error';

export interface ScriptRun {
  id: number;
  script_id: number | null;
  command_name: string;
  triggered_by: string;
  triggered_by_id: string;
  source: 'discord' | 'web';
  status: RunStatus;
  exit_code: number | null;
  output: string;
  started_at: string;
  finished_at: string | null;
}

export interface VikunjaProjectMap {
  id: number;
  key: string;
  display_name: string;
  vikunja_project_id: number;
  channel_id: string;
  enabled: number;
  container_id: number | null;
  /** JSON number[] — labels offered in the triage dropdown (empty = all, first 25) */
  label_ids: string;
}

export interface FeatureRequest {
  id: number;
  project_map_id: number;
  vikunja_task_id: number;
  thread_id: string;
  requester_id: string;
  requester_name: string;
  title: string;
  done: number;
  bucket_id: number;
  triage_message_id: string;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  source: 'discord' | 'web' | 'system';
  action: string;
  target: string;
  detail: string;
}
