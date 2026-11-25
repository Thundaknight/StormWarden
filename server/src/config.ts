import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });

function loadJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretFile = path.join(dataDir, '.jwt-secret');
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

// Read package.json at runtime so the UI shows the version that's actually running.
function loadVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export const config = {
  port: parseInt(process.env.PORT || '8090', 10),
  dataDir,
  dbFile: path.join(dataDir, 'stormwarden.db'),
  jwtSecret: loadJwtSecret(),
  tokenTtl: process.env.TOKEN_TTL || '7d',
  dockerHost: process.env.DOCKER_HOST || '',
  dockerSocket: process.env.DOCKER_SOCK || '/var/run/docker.sock',
  /** Shell used to run admin scripts. bash is in the image; falls back to sh if missing. */
  scriptShell: process.env.SCRIPT_SHELL || (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'),
  /** Max captured output per script run (bytes); older output is trimmed from the front. */
  maxRunOutput: parseInt(process.env.MAX_RUN_OUTPUT || String(256 * 1024), 10),
  vikunjaPollMs: parseInt(process.env.VIKUNJA_POLL_MS || '60000', 10),
  version: loadVersion(),
};
