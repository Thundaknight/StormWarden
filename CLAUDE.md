# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

StormWarden is the partner app to Stormsmith (github.com/Thundaknight/Stormsmith). It's a web control panel plus a Discord bot for the non-game Docker containers on StormTower (Unraid). Discord members get role/user-gated container control, admin-authored scripts exposed as slash commands, and `/request` feature requests that become Vikunja tasks with a two-way synced Discord thread. README.md has the operator-facing details.

## Commands

npm workspaces (`server`, `web`). `npm run build` is the type check; there are no tests or linter.
```sh
npm install && npm run dev   # :8090
npm run dev:web              # :5173
docker build -t thundaknight/stormwarden .
```
The version lives in three package.json files (`/`, `/server`, `/web`); bump them together. `config.version` reads server/package.json at runtime.

## Architecture (server/src)

- `db.ts`: better-sqlite3, `$DATA_DIR/stormwarden.db`, all queries. Schema changes: edit the CREATE TABLE, then add an idempotent `ALTER TABLE ... ADD COLUMN` guarded the way Stormsmith's `addColumn` is (not yet needed). Key/value `settings` table backs Discord + Vikunja config (`getSettings`/`updateSettings`, JSON-encoded values).
- `auth.ts`: JWT bearer. Every web user is an admin, so `requireAuth` is the only gate.
- `docker.ts`: the only dockerode user. Containers are tracked **by name** (stable across compose recreates).
- `scriptRunner.ts`: spawns `bash -c "exec 2>&1; set -e -x; <body>"` detached (its own process group, so a timeout kills `docker compose` children too). One run per script at a time (in-memory lock). Output is flushed to `script_runs` every 1.5s, and listeners get the full output so far. **Invariant: user input is never interpolated into a script body**; identity goes in `SW_*` env vars only.
- `vikunja.ts`: tries `/api/v2` (POST create, `{items}` envelopes), and falls back to `/api/v1` (PUT create, bare arrays) on 404/405. Text↔HTML helpers live here.
- `discord/perms.ts`: the whole Discord permission model (warden admin bypass, role/user grants).
- `discord/bot.ts`: client lifecycle, guild command registration (`/docker`, `/request`, plus one command per enabled script; re-registered via `queueCommandRefresh()` whenever scripts change), interaction routing, live script output via an `OutputSink` (reply vs. channel message; public messages are edited directly so long runs outlive the 15-minute interaction token).
- `discord/requests.ts`: `/request` → Vikunja task + thread, thread message → comment (records the comment id in `synced_comments`), and a poll loop for comment → thread and done → archive.
- `routes/`: thin Express routers (`containers`, `scripts`, `requests`, `settings`, `users`, `audit`, `auth`). Every mutation calls `audit()`.

## Web (web/src)

React 18 + react-router. Styles are copied from Stormsmith (`styles.css`) plus a StormWarden block at the end. `components/GrantEditor.tsx` is the shared role/user grant editor. `useGuildMeta` caches the bot's roles/channels for pickers. The web UI polls (no WebSocket): containers every 10s, script runs every 1.5s while open.
