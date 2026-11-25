import { spawn } from 'child_process';
import fs from 'fs';
import { config } from './config';
import { audit, createRun, finishRun, getContainer, updateRunOutput } from './db';
import type { RunStatus, Script } from './types';

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
export function runScript(script: Script, actor: RunActor, onOutput?: OutputListener): { runId: number; done: Promise<RunResult> } {
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
  running.set(script.id, { runId, actor: actor.name, startedAt });
  audit(actor.name, actor.source, 'script.run', `/${script.command_name}`, `run #${runId}`);

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
  });

  let output = '';
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
export const RESERVED_COMMANDS = new Set(['docker', 'request', 'warden']);
