import type {
  AuditEntry, BotStatus, ContainerGrant, FeatureRequest, GuildMeta, HostContainer, ManagedContainer, ProjectMap, Run,
  RunSummary, Script, Settings, SubjectRef, User, VikunjaLabel, VikunjaProject,
} from './types';

const TOKEN_KEY = 'sw_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) clearToken();
    throw new ApiError(res.status, (data as any).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  authStatus: () => request<{ needsSetup: boolean; version: string; discordLogin: boolean; passwordLogin: boolean }>('GET', '/api/auth/status'),
  setPasswordLogin: (disabled: boolean) => request<{ ok: boolean }>('POST', '/api/auth/password-login', { disabled }),
  unlinkDiscord: () => request<{ ok: boolean }>('POST', '/api/auth/discord/unlink'),
  setup: (username: string, password: string) => request<{ token: string; user: User }>('POST', '/api/auth/setup', { username, password }),
  login: (username: string, password: string) => request<{ token: string; user: User }>('POST', '/api/auth/login', { username, password }),
  me: () => request<{ user: { userId: number; username: string; role: 'admin'; discord_username: string } }>('GET', '/api/auth/me'),

  listUsers: () => request<{ users: User[] }>('GET', '/api/users'),
  createUser: (username: string, password: string) => request<{ user: User }>('POST', '/api/users', { username, password }),
  setPassword: (id: number, password: string, currentPassword?: string) =>
    request<{ ok: boolean }>('POST', `/api/users/${id}/password`, { password, currentPassword }),
  deleteUser: (id: number) => request<{ ok: boolean }>('DELETE', `/api/users/${id}`),

  listContainers: () => request<{ containers: ManagedContainer[]; dockerError: string }>('GET', '/api/containers'),
  availableContainers: () => request<{ containers: HostContainer[] }>('GET', '/api/containers/available'),
  addContainer: (container_name: string, display_name: string, description: string) =>
    request<{ container: ManagedContainer }>('POST', '/api/containers', { container_name, display_name, description }),
  updateContainer: (id: number, display_name: string, description: string) =>
    request('PUT', `/api/containers/${id}`, { display_name, description }),
  setContainerGrants: (id: number, grants: ContainerGrant[]) => request('PUT', `/api/containers/${id}/grants`, { grants }),
  removeContainer: (id: number) => request('DELETE', `/api/containers/${id}`),
  containerAction: (id: number, action: 'start' | 'stop' | 'restart') => request('POST', `/api/containers/${id}/action`, { action }),
  containerLogs: (id: number, tail = 200) => request<{ logs: string }>('GET', `/api/containers/${id}/logs?tail=${tail}`),

  listScripts: () => request<{ scripts: Script[] }>('GET', '/api/scripts'),
  getScript: (id: number) => request<{ script: Script }>('GET', `/api/scripts/${id}`),
  createScript: (data: Partial<Script>) => request<{ script: Script }>('POST', '/api/scripts', data),
  updateScript: (id: number, data: Partial<Script>) => request<{ script: Script }>('PUT', `/api/scripts/${id}`, data),
  setScriptGrants: (id: number, grants: SubjectRef[]) => request('PUT', `/api/scripts/${id}/grants`, { grants }),
  deleteScript: (id: number) => request('DELETE', `/api/scripts/${id}`),
  runScript: (id: number, options: Record<string, string> = {}) => request<{ runId: number }>('POST', `/api/scripts/${id}/run`, { options }),
  listRuns: (scriptId?: number, limit = 50) =>
    request<{ runs: RunSummary[] }>('GET', `/api/scripts/runs?limit=${limit}${scriptId ? `&script=${scriptId}` : ''}`),
  getRun: (runId: number) => request<{ run: Run }>('GET', `/api/scripts/runs/${runId}`),

  getSettings: () => request<{ settings: Settings; discord: BotStatus }>('GET', '/api/settings'),
  saveSettings: (data: Partial<Record<keyof Settings, unknown>>) =>
    request<{ settings: Settings; discord: BotStatus }>('PUT', '/api/settings', data),
  restartBot: () => request<{ discord: BotStatus }>('POST', '/api/settings/discord/restart'),
  guildMeta: () => request<GuildMeta>('GET', '/api/settings/discord/meta'),
  searchMembers: (q: string) => request<{ members: Array<{ id: string; name: string }> }>('GET', `/api/settings/discord/members?q=${encodeURIComponent(q)}`),

  testVikunja: () => request<{ ok: boolean; projectCount: number }>('GET', '/api/requests/vikunja/test'),
  vikunjaLabels: () => request<{ labels: VikunjaLabel[] }>('GET', '/api/requests/vikunja/labels'),
  vikunjaProjects: () => request<{ projects: VikunjaProject[] }>('GET', '/api/requests/vikunja/projects'),
  listProjectMaps: () => request<{ projects: ProjectMap[] }>('GET', '/api/requests/projects'),
  createProjectMap: (data: Partial<ProjectMap>) => request<{ project: ProjectMap }>('POST', '/api/requests/projects', data),
  updateProjectMap: (id: number, data: Partial<ProjectMap>) => request<{ project: ProjectMap }>('PUT', `/api/requests/projects/${id}`, data),
  setProjectGrants: (id: number, grants: SubjectRef[]) => request('PUT', `/api/requests/projects/${id}/grants`, { grants }),
  deleteProjectMap: (id: number) => request('DELETE', `/api/requests/projects/${id}`),
  listRequests: () => request<{ requests: FeatureRequest[] }>('GET', '/api/requests'),
  syncRequests: () => request<{ checked: number; posted: number; closed: number }>('POST', '/api/requests/sync'),

  audit: (before?: number) => request<{ entries: AuditEntry[] }>('GET', `/api/audit${before ? `?before=${before}` : ''}`),
};
