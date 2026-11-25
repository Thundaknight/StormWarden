import { getSettings } from './db';

/**
 * Minimal Vikunja client. Targets /api/v2 (Vikunja 2.4+, where create = POST and lists come wrapped
 * in {items, total, ...}). If a v2 route 404s/405s it retries the v1 equivalent (create = PUT, bare
 * arrays), so it keeps working on older instances and on any route v2 renamed.
 */

export interface VikunjaProject { id: number; title: string; archived?: boolean; parent_project_id?: number }
export interface VikunjaTask { id: number; title: string; done: boolean; identifier?: string; index?: number; project_id: number }
export interface VikunjaComment {
  id: number;
  comment: string;
  created: string;
  author?: { id: number; username: string; name?: string };
}

class VikunjaError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function baseUrl(): string {
  const url = getSettings().vikunja_url.trim().replace(/\/+$/, '');
  if (!url) throw new Error('Vikunja URL is not configured');
  return url.replace(/\/api\/v[12]$/, '');
}

async function raw(method: string, path: string, body?: unknown): Promise<any> {
  const token = getSettings().vikunja_token.trim();
  if (!token) throw new Error('Vikunja API token is not configured');
  const res = await fetch(baseUrl() + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data?.detail || data?.message || data?.title || `HTTP ${res.status}`;
    throw new VikunjaError(res.status, `Vikunja: ${msg}`);
  }
  return data;
}

type Verb = 'GET' | 'CREATE' | 'UPDATE' | 'DELETE';
const V2_METHOD: Record<Verb, string> = { GET: 'GET', CREATE: 'POST', UPDATE: 'PATCH', DELETE: 'DELETE' };
const V1_METHOD: Record<Verb, string> = { GET: 'GET', CREATE: 'PUT', UPDATE: 'POST', DELETE: 'DELETE' };

async function call(verb: Verb, path: string, body?: unknown): Promise<any> {
  try {
    return await raw(V2_METHOD[verb], `/api/v2${path}`, body);
  } catch (err) {
    if (err instanceof VikunjaError && (err.status === 404 || err.status === 405)) {
      return raw(V1_METHOD[verb], `/api/v1${path}`, body);
    }
    throw err;
  }
}

function unwrapList<T>(data: any): T[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text → the HTML Vikunja's editor stores. */
export function textToHtml(s: string): string {
  return s.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/** Vikunja's HTML → plain text suitable for a Discord message. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const vikunja = {
  isConfigured(): boolean {
    const s = getSettings();
    return !!(s.vikunja_url.trim() && s.vikunja_token.trim());
  },

  taskUrl(taskId: number): string {
    return `${baseUrl()}/tasks/${taskId}`;
  },

  async info(): Promise<{ version: string }> {
    const data = await call('GET', '/info');
    return { version: data?.version || 'unknown' };
  },

  async listProjects(): Promise<VikunjaProject[]> {
    const out: VikunjaProject[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await call('GET', `/projects?page=${page}&per_page=50`);
      const items = unwrapList<VikunjaProject>(data);
      out.push(...items);
      const totalPages = data && !Array.isArray(data) ? data.total_pages : undefined;
      if (items.length < 50 || (totalPages && page >= totalPages)) break;
    }
    return out.filter((p) => p.id > 0 && !p.archived);
  },

  async createTask(projectId: number, title: string, descriptionHtml: string): Promise<VikunjaTask> {
    return call('CREATE', `/projects/${projectId}/tasks`, { title, description: descriptionHtml });
  },

  async getTask(taskId: number): Promise<VikunjaTask> {
    return call('GET', `/tasks/${taskId}`);
  },

  async listComments(taskId: number): Promise<VikunjaComment[]> {
    return unwrapList<VikunjaComment>(await call('GET', `/tasks/${taskId}/comments`));
  },

  async addComment(taskId: number, html: string): Promise<VikunjaComment> {
    return call('CREATE', `/tasks/${taskId}/comments`, { comment: html });
  },
};
