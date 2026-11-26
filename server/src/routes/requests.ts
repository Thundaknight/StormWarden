import { Router } from 'express';
import { requireAuth } from '../auth';
import {
  audit, createProjectMap, getContainer, deleteProjectMap, getProjectMap, getProjectMapByKey, isSubjectType, listProjectGrants,
  listProjectMaps, listRequests, setProjectGrants, updateProjectMap, type ProjectMapInput,
} from '../db';
import { discordBot } from '../discord/bot';
import { requestSync } from '../discord/requests';
import { vikunja } from '../vikunja';
import { asyncRoute } from './helpers';

const router = Router();
router.use(requireAuth);

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

function parse(body: any, existingId?: number): { input?: ProjectMapInput; error?: string } {
  const key = String(body?.key || '').trim().toLowerCase();
  if (!KEY_RE.test(key)) return { error: 'Key must be 1–24 chars: lowercase letters, numbers or -' };
  const clash = getProjectMapByKey(key);
  if (clash && clash.id !== existingId) return { error: 'That key is already used' };
  const pid = parseInt(String(body?.vikunja_project_id || ''), 10);
  if (!pid) return { error: 'Pick a Vikunja project' };
  const channel = String(body?.channel_id || '').trim();
  if (channel && !/^\d{15,22}$/.test(channel)) return { error: 'Invalid channel id' };
  const containerId = body?.container_id ? parseInt(String(body.container_id), 10) : null;
  if (containerId) {
    if (!getContainer(containerId)) return { error: 'Linked container not found' };
    const other = listProjectMaps().find((p) => p.container_id === containerId && p.id !== existingId);
    if (other) return { error: `That container already has a request project (${other.display_name})` };
  }
  const labelIds = (Array.isArray(body?.label_ids) ? body.label_ids : []).map((x: unknown) => parseInt(String(x), 10)).filter((x: number) => x > 0);
  if (labelIds.length > 25) return { error: 'Pick at most 25 triage labels (Discord dropdown limit)' };
  return {
    input: {
      key, display_name: String(body?.display_name || key).slice(0, 80), vikunja_project_id: pid,
      channel_id: channel, enabled: body?.enabled === false || body?.enabled === 0 ? 0 : 1,
      container_id: containerId, label_ids: JSON.stringify(labelIds),
    },
  };
}

router.get('/vikunja/test', asyncRoute(async (_req, res) => {
  const projects = await vikunja.listProjects();
  res.json({ ok: true, projectCount: projects.length });
}));

router.get('/vikunja/projects', asyncRoute(async (_req, res) => {
  res.json({ projects: await vikunja.listProjects() });
}));

router.get('/vikunja/labels', asyncRoute(async (_req, res) => {
  res.json({ labels: await vikunja.listLabels() });
}));

router.get('/projects', (_req, res) => {
  const grants = listProjectGrants();
  res.json({
    projects: listProjectMaps().map((p) => ({
      ...p, label_ids: JSON.parse(p.label_ids || '[]'), grants: grants.filter((g) => g.project_map_id === p.id),
    })),
  });
});

router.post('/projects', (req, res) => {
  const { input, error } = parse(req.body);
  if (!input) return void res.status(400).json({ error });
  const p = createProjectMap(input);
  audit(req.user!.username, 'web', 'request-project.create', p.display_name);
  res.json({ project: p });
});

router.put('/projects/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!getProjectMap(id)) return void res.status(404).json({ error: 'Not found' });
  const { input, error } = parse(req.body, id);
  if (!input) return void res.status(400).json({ error });
  res.json({ project: updateProjectMap(id, input) });
  discordBot.queueCommandRefresh(); // enabling/disabling a project changes who sees /request
});

router.put('/projects/:id/grants', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = getProjectMap(id);
  if (!p) return void res.status(404).json({ error: 'Not found' });
  const grants = (Array.isArray(req.body?.grants) ? req.body.grants : [])
    .filter((g: any) => isSubjectType(g?.subject_type) && /^\d{15,22}$/.test(String(g?.subject_id || '')))
    .map((g: any) => ({ subject_type: g.subject_type, subject_id: String(g.subject_id), subject_name: String(g.subject_name || '').slice(0, 100) }));
  setProjectGrants(id, grants);
  audit(req.user!.username, 'web', 'request-project.grants', p.display_name, `${grants.length} grants`);
  discordBot.queueCommandRefresh(); // grants decide who sees /request
  res.json({ grants: listProjectGrants(id) });
});

router.delete('/projects/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = getProjectMap(id);
  if (!p) return void res.status(404).json({ error: 'Not found' });
  deleteProjectMap(id);
  audit(req.user!.username, 'web', 'request-project.delete', p.display_name);
  discordBot.queueCommandRefresh();
  res.json({ ok: true });
});

router.get('/', (_req, res) => {
  const requests = listRequests(200).map((r) => ({ ...r, task_url: vikunja.isConfigured() ? vikunja.taskUrl(r.vikunja_task_id) : '' }));
  res.json({ requests });
});

router.post('/sync', asyncRoute(async (_req, res) => {
  res.json(await requestSync.poll());
}));

export default router;
