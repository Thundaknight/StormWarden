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

- `db.ts`: better-sqlite3, `$DATA_DIR/stormwarden.db`, all queries. Schema changes: edit the CREATE TABLE **and** add an `addColumn(...)` call in `initDb()`, which runs idempotent ALTERs for existing installs. Key/value `settings` table backs Discord + Vikunja config (`getSettings`/`updateSettings`, JSON-encoded values).
- `auth.ts`: JWT bearer. Every web user is an admin, so `requireAuth` is the only gate.
- `docker.ts`: the only dockerode user. Containers are tracked **by name** (stable across compose recreates).
- `scriptRunner.ts`: spawns `bash -c "exec 2>&1; set -e -x; <body>"` detached (its own process group, so a timeout kills `docker compose` children too). One run per script at a time (in-memory lock). Output is flushed to `script_runs` every 1.5s, and listeners get the full output so far. **Invariant: user input is never interpolated into a script body**; identity goes in `SW_*` env vars only.
- `vikunja.ts`: tries `/api/v2` (POST create, `{items}` envelopes), and falls back to `/api/v1` (PUT create, bare arrays) on 404/405. Text↔HTML helpers live here.
- `discord/perms.ts`: the whole Discord permission model (warden admin bypass, role/user grants). Members get view + start/stop/restart only, by design. Container logs stay web-only, and anything heavier must be an admin-authored script. The `can_logs` column exists but is unused; don't re-expose it without asking.
- `discord/bot.ts`: client lifecycle, guild command registration (`/status`, `/control`, `/request` and one command per enabled script, all hidden with `default_member_permissions=0` and revealed per role/user by `syncCommandPermissions()`; re-registered and re-synced via `queueCommandRefresh()` whenever scripts, any grants, request projects or admin roles change; enabled scripts whose name is in `RESERVED_COMMANDS` are skipped and reported in `permSync`), interaction routing, live script output via an `OutputSink` (reply vs. channel message; public messages are edited directly so long runs outlive the 15-minute interaction token).
- `discord/requests.ts`: `/request` → Vikunja task + thread, thread message → comment (records the comment id in `synced_comments`), and a poll loop for comment → thread and done → archive.
- `guard.ts`: containers StormWarden must never touch — itself (hostname → container id, or `STORMWARDEN_CONTAINER`) and Stormsmith's (reads a *temp copy* of Stormsmith's SQLite `servers.container_name` every 30s; keeps the last known list on errors). `docker.performAction` calls `assertNotProtected`, so every action path is covered. Script saves are refused if the body names StormWarden's own container.
- `discordOAuth.ts`: OAuth for web sign-in (linked accounts only; `users.discord_id`), account linking, and the `applications.commands.permissions.update` token used to sync hidden script-command visibility (auto-refreshed, stored in settings). `ALLOW_PASSWORD_LOGIN=1` overrides `password_login_disabled`.
- Script options: `scripts.options_json` (fixed choice lists). `scriptRunner.resolveOptions` is the real validation gate; values only ever become `SW_OPT_<NAME>` env vars. Confirm buttons carry a nonce → in-memory `pending` map (custom ids are capped at 100 chars).
- Request triage: `requests.ts` `renderTriage`/`applyTriage` build and apply the Kanban bucket + label selects (admins only). `vikunja_projects.container_id` gives each container one request project; `label_ids` limits the offered labels. No grants = admins only.
- `routes/`: thin Express routers (`containers`, `scripts`, `requests`, `settings`, `users`, `audit`, `auth`). Every mutation calls `audit()`.

## Web (web/src)

React 18 + react-router. Styles are copied from Stormsmith (`styles.css`) plus a StormWarden block at the end. `components/GrantEditor.tsx` is the shared role/user grant editor. `useGuildMeta` caches the bot's roles/channels for pickers. The web UI polls (no WebSocket): containers every 10s, script runs every 1.5s while open.
