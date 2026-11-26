import { spawn } from 'child_process';
import fs from 'fs';
import { config } from './config';
import { audit, createRun, finishRun, getContainer, updateRunOutput } from './db';
import type { RunStatus, Script, ScriptOption } from './types';

export interface RunActor {
  name: string;
  id: string;
  source: 'discord' | 'web';
}

export interface RunResult {
  runId: number;
  status: RunStatus;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

/** Called with the full output-so-far, at most every ~1.5s while running. */
export type OutputListener = (output: string) => void;

const running = new Map<number, { runId: number; actor: string; startedAt: number }>();

export function isScriptRunning(scriptId: number): { runId: number; actor: string; startedAt: number } | undefined {
  return running.get(scriptId);
}

// Env vars from StormWarden's own process that scripts should never see.
const SCRUBBED_ENV = ['JWT_SECRET'];

/**
 * Runs an admin-authored script on the StormWarden container's shell.
 *
 * Design notes:
 * - The script body is fixed text written by an admin in the web UI. Nothing a Discord user types is
 *   ever interpolated into it; caller identity is passed as SW_* env vars only.
 * - Runs with `set -e` (stop on first failing command) and `set -x` with PS4='$ ' so each command is
 *   echoed into the output, which makes the Discord transcript readable. Admins can opt out with
 *   `set +e` / `set +x` at the top of a script.
 * - One run per script at a time; a second invocation is rejected rather than queued.
 * - Timeout kills the whole process group (so `docker compose ... --build` children die too).
 */
export function runScript(
  script: Script, actor: RunActor, opts: { options?: Record<string, string>; onOutput?: OutputListener } = {},
): { runId: number; done: Promise<RunResult> } {
  const onOutput = opts.onOutput;
  const optionEnv = resolveOptions(script, opts.options || {});
  if (running.has(script.id)) {
    throw new Error(`/${script.command_name} is already running (started by ${running.get(script.id)!.actor}).`);
  }

  const cwd = script.working_dir.trim() || config.dataDir;
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Working directory ${cwd} does not exist inside the StormWarden container. `
      + 'Mount it at the same path as on the host (see README).');
  }

  const container = script.container_id ? getContainer(script.container_id) : undefined;
  const runId = createRun({
    script_id: script.id, command_name: script.command_name, triggered_by: actor.name, triggered_by_id: actor.id, source: actor.source,
  });
  const startedAt = Date.now();
  let output = '';
  running.set(script.id, { runId, actor: actor.name, startedAt });
  const optDesc = Object.entries(opts.options || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ');
  audit(actor.name, actor.source, 'script.run', `/${script.command_name}`, `run #${runId}${optDesc ? ` (${optDesc})` : ''}`);
  if (optDesc) output = `[StormWarden] Options: ${optDesc}\n`;

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SCRUBBED_ENV) delete env[k];
  Object.assign(env, {
    PS4: '$ ',
    GIT_TERMINAL_PROMPT: '0', // fail fast instead of hanging on a credential prompt
    NO_COLOR: '1',
    BUILDKIT_PROGRESS: 'plain',
    COMPOSE_PROGRESS: 'plain',
    COMPOSE_ANSI: 'never',
    SW_RUN_ID: String(runId),
    SW_COMMAND: script.command_name,
    SW_TRIGGERED_BY: actor.name,
    SW_TRIGGERED_BY_ID: actor.id,
    SW_SOURCE: actor.source,
    SW_CONTAINER: container?.container_name || '',
    ...optionEnv,
  });

  let trimmed = false;
  const append = (chunk: Buffer | string) => {
    output += chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');
    if (output.length > config.maxRunOutput) {
      output = output.slice(output.length - config.maxRunOutput);
      trimmed = true;
    }
  };
  const currentOutput = () => (trimmed ? '[…earlier output trimmed…]\n' : '') + output;

  // Merge stderr into stdout inside the shell so command traces and their output stay in order.
  const wrapped = `exec 2>&1\nset -e -x\n${script.body}`;
  const child = spawn(config.scriptShell, ['-c', wrapped], {
    cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  let lastFlushed = '';
  const flush = () => {
    const out = currentOutput();
    if (out === lastFlushed) return;
    lastFlushed = out;
    updateRunOutput(runId, out);
    try { onOutput?.(out); } catch { /* listener errors never kill a run */ }
  };
  const ticker = setInterval(flush, 1500);

  let timedOut = false;
  const killGroup = (signal: NodeJS.Signals) => {
    try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ }
  };
  const timeoutMs = Math.max(5, script.timeout_sec) * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    append(`\n[StormWarden] Timed out after ${script.timeout_sec}s — stopping.\n`);
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), 5000).unref();
  }, timeoutMs);

  const done = new Promise<RunResult>((resolve) => {
    const finish = (status: RunStatus, exitCode: number | null) => {
      clearInterval(ticker);
      clearTimeout(timer);
      running.delete(script.id);
      const out = currentOutput();
      finishRun(runId, status, exitCode, out);
      try { onOutput?.(out); } catch { /* ignore */ }
      audit(actor.name, actor.source, `script.${status}`, `/${script.command_name}`, `run #${runId}, exit ${exitCode ?? '—'}`);
      resolve({ runId, status, exitCode, output: out, durationMs: Date.now() - startedAt });
    };
    child.on('error', (err) => {
      append(`\n[StormWarden] Failed to start shell: ${err.message}\n`);
      finish('error', null);
    });
    child.on('close', (code) => {
      if (timedOut) finish('timeout', code);
      else finish(code === 0 ? 'success' : 'failed', code);
    });
  });

  return { runId, done };
}

/** Discord slash command names: 1–32 chars, lowercase letters, digits, - and _. */
export const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Built-in command names that admin scripts may not shadow. */
export const RESERVED_COMMANDS = new Set(['status', 'control', 'request', 'docker', 'warden']);

export function parseOptions(script: Pick<Script, 'options_json'>): ScriptOption[] {
  try {
    const v = JSON.parse(script.options_json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Turns caller-chosen option values into SW_OPT_<NAME> env vars, accepting only values from the
 * admin-defined choice list. Discord already enforces choices, but this is the real gate.
 */
export function resolveOptions(script: Script, provided: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const opt of parseOptions(script)) {
    const v = provided[opt.name];
    if (v === undefined || v === null || v === '') {
      if (opt.required) throw new Error(`Option "${opt.name}" is required.`);
      env[`SW_OPT_${opt.name.toUpperCase().replace(/-/g, '_')}`] = '';
      continue;
    }
    if (!opt.choices.some((c) => c.value === v)) throw new Error(`"${v}" is not an allowed value for ${opt.name}.`);
    env[`SW_OPT_${opt.name.toUpperCase().replace(/-/g, '_')}`] = v;
  }
  return env;
}

export const OPTION_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Validates admin input for a script's option list; returns cleaned options or an error. */
export function validateOptions(input: unknown): { options?: ScriptOption[]; error?: string } {
  if (!Array.isArray(input)) return { options: [] };
  if (input.length > 5) return { error: 'At most 5 options per script' };
  const seen = new Set<string>();
  const out: ScriptOption[] = [];
  for (const raw of input as any[]) {
    const name = String(raw?.name || '').trim().toLowerCase();
    if (!OPTION_NAME_RE.test(name)) return { error: `Option name "${name}" must be 1–32 chars: lowercase letters, numbers, - or _` };
    if (seen.has(name)) return { error: `Duplicate option "${name}"` };
    seen.add(name);
    const choices = (Array.isArray(raw?.choices) ? raw.choices : [])
      .map((c: any) => ({ label: String(c?.label || c?.value || '').trim().slice(0, 100), value: String(c?.value || '').trim().slice(0, 100) }))
      .filter((c: { label: string; value: string }) => c.value);
    if (!choices.length) return { error: `Option "${name}" needs at least one choice` };
    if (choices.length > 25) return { error: `Option "${name}" has more than 25 choices (Discord's limit)` };
    if (new Set(choices.map((c: { value: string }) => c.value)).size !== choices.length) return { error: `Option "${name}" has duplicate values` };
    out.push({ name, description: String(raw?.description || name).slice(0, 100) || name, required: !!raw?.required, choices });
  }
  // Discord requires required options to come before optional ones
  out.sort((a, b) => Number(b.required) - Number(a.required));
  return { options: out };
}
