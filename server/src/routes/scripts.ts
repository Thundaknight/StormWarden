import { Router } from 'express';
import { requireAuth } from '../auth';
import {
  audit, createScript, deleteScript, getContainer, getRun, getScript, getScriptByCommand, isSubjectType,
  listRuns, listScriptGrants, listScripts, setScriptGrants, updateScript, type ScriptInput,
} from '../db';
import { discordBot } from '../discord/bot';
import { COMMAND_NAME_RE, isScriptRunning, RESERVED_COMMANDS, runScript } from '../scriptRunner';

const router = Router();
router.use(requireAuth);

function parseInput(body: any, existingId?: number): { input?: ScriptInput; error?: string } {
  const command_name = String(body?.command_name || '').trim().toLowerCase();
  if (!COMMAND_NAME_RE.test(command_name)) {
    return { error: 'Command name must be 1–32 characters: lowercase letters, numbers, - or _' };
  }
  if (RESERVED_COMMANDS.has(command_name)) return { error: `/${command_name} is a built-in command` };
  const clash = getScriptByCommand(command_name);
  if (clash && clash.id !== existingId) return { error: `/${command_name} already exists` };
  const scriptBody = String(body?.body || '').replace(/\r\n/g, '\n');
  if (!scriptBody.trim()) return { error: 'Script body is empty' };
  const containerId = body?.container_id ? parseInt(String(body.container_id), 10) : null;
  if (containerId && !getContainer(containerId)) return { error: 'Linked container not found' };
  const timeout = parseInt(String(body?.timeout_sec ?? 600), 10);
  return {
    input: {
      command_name,
      description: String(body?.description || '').slice(0, 100),
      container_id: containerId,
      working_dir: String(body?.working_dir || '').trim(),
      body: scriptBody,
      timeout_sec: Number.isFinite(timeout) ? Math.min(Math.max(timeout, 5), 3600) : 600,
      require_confirm: body?.require_confirm === false ? 0 : 1,
      ephemeral_output: body?.ephemeral_output ? 1 : 0,
      enabled: body?.enabled === false ? 0 : 1,
    },
  };
}

function withExtras(id: number) {
  const s = getScript(id)!;
  const last = listRuns({ scriptId: id, limit: 1 })[0] || null;
  return { ...s, grants: listScriptGrants(id), last_run: last, running: !!isScriptRunning(id) };
}

router.get('/', (_req, res) => {
  res.json({ scripts: listScripts().map((s) => withExtras(s.id)) });
});

router.get('/runs', (req, res) => {
  const scriptId = req.query.script ? parseInt(String(req.query.script), 10) : undefined;
  res.json({ runs: listRuns({ scriptId, limit: parseInt(String(req.query.limit || '50'), 10) }) });
});

router.get('/runs/:runId', (req, res) => {
  const run = getRun(parseInt(req.params.runId, 10));
  if (!run) return void res.status(404).json({ error: 'Run not found' });
  res.json({ run });
});

router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!getScript(id)) return void res.status(404).json({ error: 'Not found' });
  res.json({ script: withExtras(id) });
});

router.post('/', (req, res) => {
  const { input, error } = parseInput(req.body);
  if (!input) return void res.status(400).json({ error });
  const s = createScript(input);
  audit(req.user!.username, 'web', 'script.create', `/${s.command_name}`);
  discordBot.queueCommandRefresh();
  res.json({ script: withExtras(s.id) });
});

router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const prev = getScript(id);
  if (!prev) return void res.status(404).json({ error: 'Not found' });
  const { input, error } = parseInput(req.body, id);
  if (!input) return void res.status(400).json({ error });
  updateScript(id, input);
  audit(req.user!.username, 'web', 'script.update', `/${input.command_name}`,
    prev.body !== input.body ? 'script body changed' : '');
  discordBot.queueCommandRefresh();
  res.json({ script: withExtras(id) });
});

router.put('/:id/grants', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = getScript(id);
  if (!s) return void res.status(404).json({ error: 'Not found' });
  const grants = (Array.isArray(req.body?.grants) ? req.body.grants : [])
    .filter((g: any) => isSubjectType(g?.subject_type) && /^\d{15,22}$/.test(String(g?.subject_id || '')))
    .map((g: any) => ({ subject_type: g.subject_type, subject_id: String(g.subject_id), subject_name: String(g.subject_name || '').slice(0, 100) }));
  setScriptGrants(id, grants);
  audit(req.user!.username, 'web', 'script.grants', `/${s.command_name}`, `${grants.length} grants`);
  res.json({ grants: listScriptGrants(id) });
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = getScript(id);
  if (!s) return void res.status(404).json({ error: 'Not found' });
  deleteScript(id);
  audit(req.user!.username, 'web', 'script.delete', `/${s.command_name}`);
  discordBot.queueCommandRefresh();
  res.json({ ok: true });
});

/** Run from the web UI. Returns immediately; poll /runs/:runId for output. */
router.post('/:id/run', (req, res) => {
  const s = getScript(parseInt(req.params.id, 10));
  if (!s) return void res.status(404).json({ error: 'Not found' });
  try {
    const { runId, done } = runScript(s, { name: req.user!.username, id: `web:${req.user!.userId}`, source: 'web' });
    done.then((r) => discordBot.postLog(`🛠️ **${req.user!.username}** (web) ran \`/${s.command_name}\` → **${r.status}** (run #${r.runId})`));
    res.json({ runId });
  } catch (err: any) {
    res.status(409).json({ error: err?.message || String(err) });
  }
});

export default router;
