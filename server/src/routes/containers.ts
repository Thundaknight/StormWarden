import { Router } from 'express';
import { requireAuth } from '../auth';
import {
  addContainer, audit, deleteContainer, getContainer, isSubjectType, listContainerGrants, listContainers,
  setContainerGrants, updateContainer,
} from '../db';
import { getLogs, getStates, listAllContainers, performAction, type ContainerAction } from '../docker';
import { asyncRoute } from './helpers';

const router = Router();
router.use(requireAuth);

/** Managed containers with live state and their Discord grants. */
router.get('/', asyncRoute(async (_req, res) => {
  const managed = listContainers();
  let states = new Map();
  let dockerError = '';
  try {
    states = await getStates(managed.map((c) => c.container_name));
  } catch (err: any) {
    dockerError = err?.message || String(err);
  }
  const grants = listContainerGrants();
  res.json({
    dockerError,
    containers: managed.map((c) => ({
      ...c,
      state: states.get(c.container_name)?.state ?? 'not_found',
      status: states.get(c.container_name)?.status ?? '',
      image: states.get(c.container_name)?.image ?? '',
      compose_project: states.get(c.container_name)?.composeProject ?? '',
      compose_working_dir: states.get(c.container_name)?.composeWorkingDir ?? '',
      grants: grants.filter((g) => g.container_id === c.id),
    })),
  });
}));

/** Every container on the host, for the "add container" picker. */
router.get('/available', asyncRoute(async (_req, res) => {
  const managed = new Set(listContainers().map((c) => c.container_name));
  const all = await listAllContainers();
  res.json({ containers: all.map((c) => ({ ...c, managed: managed.has(c.name) })) });
}));

router.post('/', (req, res) => {
  const { container_name, display_name, description } = req.body || {};
  if (!container_name) return void res.status(400).json({ error: 'container_name is required' });
  if (listContainers().some((c) => c.container_name === container_name)) {
    return void res.status(409).json({ error: 'That container is already managed' });
  }
  const c = addContainer(String(container_name), String(display_name || container_name).slice(0, 80), String(description || '').slice(0, 500));
  audit(req.user!.username, 'web', 'container.add', c.container_name);
  res.json({ container: c });
});

router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = getContainer(id);
  if (!c) return void res.status(404).json({ error: 'Not found' });
  const { display_name, description } = req.body || {};
  updateContainer(id, String(display_name || c.display_name).slice(0, 80), String(description ?? c.description).slice(0, 500));
  res.json({ container: getContainer(id) });
});

router.put('/:id/grants', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = getContainer(id);
  if (!c) return void res.status(404).json({ error: 'Not found' });
  const grants = Array.isArray(req.body?.grants) ? req.body.grants : [];
  const clean = grants
    .filter((g: any) => isSubjectType(g?.subject_type) && /^\d{15,22}$/.test(String(g?.subject_id || '')))
    .map((g: any) => ({
      subject_type: g.subject_type, subject_id: String(g.subject_id), subject_name: String(g.subject_name || '').slice(0, 100),
      can_view: !!g.can_view, can_control: !!g.can_control, can_logs: false,
    }));
  setContainerGrants(id, clean);
  audit(req.user!.username, 'web', 'container.grants', c.container_name, `${clean.length} grants`);
  res.json({ grants: listContainerGrants(id) });
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = getContainer(id);
  if (!c) return void res.status(404).json({ error: 'Not found' });
  deleteContainer(id);
  audit(req.user!.username, 'web', 'container.remove', c.container_name);
  res.json({ ok: true });
});

router.post('/:id/action', asyncRoute(async (req, res) => {
  const c = getContainer(parseInt(req.params.id, 10));
  if (!c) return void res.status(404).json({ error: 'Not found' });
  const action = String(req.body?.action) as ContainerAction;
  if (!['start', 'stop', 'restart'].includes(action)) return void res.status(400).json({ error: 'Invalid action' });
  await performAction(c.container_name, action);
  audit(req.user!.username, 'web', `container.${action}`, c.container_name);
  res.json({ ok: true });
}));

router.get('/:id/logs', asyncRoute(async (req, res) => {
  const c = getContainer(parseInt(req.params.id, 10));
  if (!c) return void res.status(404).json({ error: 'Not found' });
  const tail = parseInt(String(req.query.tail || '200'), 10) || 200;
  res.json({ logs: await getLogs(c.container_name, tail) });
}));

export default router;
