import Docker from 'dockerode';
import { config } from './config';

function createClient(): Docker {
  if (config.dockerHost) {
    const url = new URL(config.dockerHost.replace(/^tcp:/, 'http:'));
    return new Docker({ host: url.hostname, port: parseInt(url.port || '2375', 10) });
  }
  return new Docker({ socketPath: config.dockerSocket });
}

export const docker = createClient();

export type ContainerState =
  | 'running' | 'paused' | 'restarting' | 'exited' | 'created' | 'dead' | 'removing' | 'not_found';

export interface ContainerSummary {
  name: string;
  image: string;
  state: ContainerState;
  status: string;
  composeProject: string;
  composeWorkingDir: string;
}

export type ContainerAction = 'start' | 'stop' | 'restart';

function cleanName(names: string[] | undefined): string {
  return (names?.[0] || '').replace(/^\//, '');
}

/** Every container on the host (running or not), keyed for the import picker and status lookups. */
export async function listAllContainers(): Promise<ContainerSummary[]> {
  const list = await docker.listContainers({ all: true });
  return list
    .map((c) => ({
      name: cleanName(c.Names),
      image: c.Image,
      state: c.State as ContainerState,
      status: c.Status,
      composeProject: c.Labels?.['com.docker.compose.project'] || '',
      composeWorkingDir: c.Labels?.['com.docker.compose.project.working_dir'] || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** State by container name; containers that no longer exist come back as not_found. */
export async function getStates(names: string[]): Promise<Map<string, ContainerSummary>> {
  const all = await listAllContainers();
  const byName = new Map(all.map((c) => [c.name, c]));
  const out = new Map<string, ContainerSummary>();
  for (const n of names) {
    out.set(n, byName.get(n) || {
      name: n, image: '', state: 'not_found', status: 'Container not found', composeProject: '', composeWorkingDir: '',
    });
  }
  return out;
}

export async function performAction(name: string, action: ContainerAction): Promise<void> {
  const c = docker.getContainer(name);
  try {
    if (action === 'start') await c.start();
    else if (action === 'stop') await c.stop({ t: 30 });
    else await c.restart({ t: 30 });
  } catch (err: any) {
    // 304 = already in that state; treat as success
    if (err?.statusCode === 304) return;
    throw err;
  }
}

export async function getUptimeStart(name: string): Promise<string | null> {
  try {
    const info = await docker.getContainer(name).inspect();
    return info.State.Running ? info.State.StartedAt : null;
  } catch {
    return null;
  }
}

/** Splits Docker's multiplexed log stream (8-byte frame headers) when the container has no TTY. */
function demux(buf: Buffer): string {
  if (buf.length < 8 || ![0, 1, 2].includes(buf[0]) || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) {
    return buf.toString('utf8');
  }
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }
  return Buffer.concat(parts).toString('utf8');
}

export async function getLogs(name: string, tail: number): Promise<string> {
  const raw = await docker.getContainer(name).logs({
    stdout: true, stderr: true, tail: Math.min(Math.max(tail, 1), 2000), timestamps: false, follow: false,
  });
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  // Strip ANSI colour codes so Discord code blocks stay readable
  return demux(buf).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
