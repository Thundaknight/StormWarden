import { Router } from 'express';
import { requireAuth } from '../auth';
import {
  audit, createProjectMap, deleteProjectMap, getProjectMap, getProjectMapByKey, isSubjectType, listProjectGrants,
  listProjectMaps, listRequests, setProjectGrants, updateProjectMap, type ProjectMapInput,
} from '../db';
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
  return {
    input: {
      key, display_name: String(body?.display_name || key).slice(0, 80), vikunja_project_id: pid,
      channel_id: channel, enabled: body?.enabled === false ? 0 : 1,
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

router.get('/projects', (_req, res) => {
  const grants = listProjectGrants();
  res.json({ projects: listProjectMaps().map((p) => ({ ...p, grants: grants.filter((g) => g.project_map_id === p.id) })) });
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
  res.json({ grants: listProjectGrants(id) });
});

router.delete('/projects/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = getProjectMap(id);
  if (!p) return void res.status(404).json({ error: 'Not found' });
  deleteProjectMap(id);
  audit(req.user!.username, 'web', 'request-project.delete', p.display_name);
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
