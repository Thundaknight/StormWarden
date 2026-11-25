# StormWarden

StormWarden is Stormsmith's partner. Stormsmith runs the game servers. StormWarden handles **everything else on StormTower**: bots, tools and services, operated from Discord by the people you choose.

- **Container control from Discord.** Members get `/docker status|start|stop|restart`, and only for the containers they've been granted. Containers are always set up beforehand on Unraid (plain Docker or Compose). StormWarden never creates or reconfigures them from Discord, and container logs are only visible in the web panel. Anything beyond start/stop/restart, like pulling or rebuilding, has to be a script command you wrote.
- **Your scripts as slash commands.** Write a script in the web UI, such as `git pull` + `docker compose -p frostgate up -d --build`. Give it a name like `updatefrostgate` and it becomes `/updatefrostgate` in Discord.
  - Scripts can offer **choices** (fixed lists you define), which reach the script as `$SW_OPT_<NAME>`.
  - Output streams live into an embed, and every run is logged with full output.
  - Failures **ping** a role or person you pick in the log channel.
  - Script commands are **hidden** from everyone except the roles or people you grant them to.
- **Feature requests into Vikunja.** Each container gets its own request project, role-gated from the web UI. `/request <project>` opens a form, files a task in the linked Vikunja project, and starts a Discord thread with a **triage panel** for admins (Kanban column and label dropdowns, filled from Vikunja). Thread replies become Vikunja comments, and Vikunja comments get posted back into the thread. When the task is marked done, the thread gets a closing note and is archived.
- **Hands off itself and Stormsmith.** StormWarden refuses to control its own container (no self-restart or self-update) and any container Stormsmith manages. It learns which those are from Stormsmith's own database.
- **Web control panel** for you, LAN-only. Sign in with a password, or with Discord as a backup (linked accounts only). You can switch password sign-in off entirely. Manage containers, per-role and per-user grants, scripts and their run history, request projects, Discord bot settings, web users, and an audit log of who did what.

Same stack and look as Stormsmith: Node 22 + TypeScript + Express + better-sqlite3 + dockerode + discord.js, and React 18 + Vite. All data lives in one SQLite file.

## Access model

| Who | Can do |
| --- | --- |
| **Web users** | Everything. The web UI is the owner's control panel, so every web account is an admin. |
| **Warden admins in Discord** (Administrator permission, the server owner, or a role you pick under *Discord Bot → Warden admins*) | Every container action, every script, every request project. |
| **Everyone else in Discord** | Only what a **grant** gives them. A grant targets a **role** (anyone holding it) or a **single user**. |

Grants are set per container (**View** or **Start/Stop/Restart**), per script (allowed or not), and per request project. A request project or script with no grants is **admins only**. Grants add up: one matching grant is enough. Triaging requests (setting the Kanban column and labels) is always admins only.

### Off-limits containers

- **StormWarden itself.** It finds its own container automatically, by matching its hostname to the container ID (override with `STORMWARDEN_CONTAINER=<name>`). It can't be added, started, stopped or restarted through StormWarden. Scripts that mention it by name are refused when you save them.
- **Stormsmith's game servers.** StormWarden reads the `servers` table from Stormsmith's SQLite file every 30s. By default that's `/mnt/user/appdata/stormsmith/stormsmith.db`, which you can change on the Containers page. It reads a temporary copy, so Stormsmith's file is never touched. Those containers can't be added, and if one you already added later gets imported into Stormsmith, it locks immediately. If the file can't be read, the last known list stays in force and the Containers page shows a warning.

## Hidden script commands

Every script command is registered with `default_member_permissions = 0`, so only Discord admins see it at first. Discord doesn't let a bot reveal commands to particular roles with its own token; that needs a server manager's OAuth token with the `applications.commands.permissions.update` scope. So, once:

1. Fill in **Application ID**, **Client secret** and **Web UI address** on the Discord Bot page. Add the redirect URI it shows to the Developer Portal under OAuth2 → Redirects.
2. Click **Authorise visibility sync** and approve in Discord.

After that, whenever you change a script's grants or the Warden admin roles, StormWarden re-syncs each command's visibility to exactly those roles and people. The token refreshes automatically; **Revoke** clears it. The run-time permission check still applies, even if someone can see a command.

## Script options (choices)

Each script can have up to 5 options, each with up to 25 choices (`Label | value`, one per line). Discord shows them as dropdowns, and StormWarden checks the value against your list again before running. The chosen value is passed only as an environment variable, `SW_OPT_<NAME>` (uppercased, with `-` turned into `_`), never written into the script text. Use it quoted:

```sh
case "$SW_OPT_TARGET" in
  frostgate) cd /mnt/user/appdata/repos/frostgate && git pull && docker compose -p frostgate up -d --build ;;
  eve)       cd /mnt/user/appdata/repos/eve-corp-progress-bot && git pull && docker compose up -d --build ;;
esac
```

## Scripts: how they run

- Scripts run in StormWarden's own container with **bash**, using `set -e -x` and stderr merged into stdout. They stop at the first failing command, and each command is echoed (`+ git pull`), so the Discord transcript reads like a terminal. Put `set +e` or `set +x` at the top to opt out.
- The image includes **git**, **ssh**, **curl**, and the **docker CLI with the Compose and Buildx plugins**. `docker compose …` talks to the host's Docker daemon through the mounted socket.
- **Nothing a Discord user types is ever inserted into a script.** The caller's identity is passed only as environment variables: `SW_TRIGGERED_BY`, `SW_TRIGGERED_BY_ID`, `SW_SOURCE` (`discord`/`web`), `SW_RUN_ID`, `SW_COMMAND`, and `SW_CONTAINER` (the linked container's name).
- Only one run of a given script can happen at a time; a second call is refused. Each script has its own timeout, which kills the whole process tree (default 600s, max 3600s).
- Options per script: confirm button before running (default on), output visible only to the caller, and enabled/disabled. A disabled script is removed from Discord.

### Why the repo folder must be mounted at the *same path*

`docker compose` runs inside StormWarden but sends its work to the **host's** Docker daemon. Relative bind mounts and build contexts in a compose file are resolved to absolute paths *before* they're sent. If the repo is at `/mnt/user/appdata/repos/frostgate` on the host, it must also be at `/mnt/user/appdata/repos/frostgate` inside StormWarden. Otherwise the daemon receives paths that don't exist on the host.

### Example: `/updatefrostgate`

1. **Containers → Add container** → pick `arctic-role-bot` and give it the display name "Frostgate (Arctic Academy Role Manager)". The picker shows the compose working directory from the container's labels.
2. **Scripts → New script**
   - Slash command: `updatefrostgate`
   - Linked container: Frostgate (this fills in the working directory from its compose labels)
   - Working directory: e.g. `/mnt/user/appdata/repos/frostgate`
   - Script:
     ```sh
     git pull
     docker compose -p frostgate up -d --build
     ```
   - Who can run it: add the Arctic Academy role (or specific people).
3. Save. The command appears in Discord within a few seconds.

## Deploying on StormTower (Unraid)

```yaml
services:
  stormwarden:
    image: thundaknight/stormwarden:latest   # or build: .
    container_name: stormwarden
    restart: unless-stopped
    ports:
      - "8090:8090"
    environment:
      - TZ=America/Vancouver
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/user/appdata/stormwarden:/app/data
      - /mnt/user/appdata:/mnt/user/appdata                   # same path on both sides! (repos, Stormsmith DB)
      # - /boot/config/ssh/root:/root/.ssh:ro                 # only if your repos pull over SSH (see below)
```

Then open `http://192.168.10.35:8090` and create the owner account. Port 8090 avoids a clash with Stormsmith on 8080.

For Discord sign-in, use a stable address as the web UI address, e.g. `https://warden.local.stormconnect.ca` through Nginx Proxy Manager. Discord redirects your browser back to it, so it only has to resolve on your LAN.

If Discord sign-in ever breaks while password sign-in is switched off, set `ALLOW_PASSWORD_LOGIN=1` on the container and restart it. That turns password sign-in back on until you remove the variable.

To build the image yourself: `docker build -t thundaknight/stormwarden .`

**`git pull` credentials.** Scripts run with `GIT_TERMINAL_PROMPT=0`, so a missing credential fails fast instead of hanging. StormWarden sees your repo folders, but not Unraid's `/root`. Run `git remote -v` in the repo:
- `https://github.com/...` on a public repo: nothing to do.
- `https://user:token@github.com/...`: works as-is, because the token lives in the repo's own `.git/config`.
- `git@github.com:...` (SSH): mount Unraid's persistent key folder read-only with `/boot/config/ssh/root:/root/.ssh:ro`, or use a dedicated deploy key folder instead.
- HTTPS with a credential helper that stores the token in `~/.git-credentials`: switch to one of the options above.

> **Security note.** StormWarden holds the Docker socket and runs shell scripts, so it effectively has root on the host. Keep the web UI on the LAN, or behind Nginx Proxy Manager with HTTPS. Only web admins can create or edit scripts. Discord members can run them, but never change them.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8090` | HTTP port |
| `DATA_DIR` | `/app/data` | SQLite DB + JWT secret |
| `DOCKER_SOCK` | `/var/run/docker.sock` | Docker socket path |
| `DOCKER_HOST` | _(unset)_ | `tcp://ip:2375` for a remote Docker API (also inherited by scripts) |
| `JWT_SECRET` | _(auto-generated)_ | Override the persisted signing secret (never passed to scripts) |
| `SCRIPT_SHELL` | `/bin/bash` | Shell used for scripts |
| `MAX_RUN_OUTPUT` | `262144` | Bytes of output kept per run (oldest trimmed) |
| `VIKUNJA_POLL_MS` | `60000` | How often Vikunja comments/done-state are checked |
| `STORMWARDEN_CONTAINER` | _(auto)_ | Own container name, if auto-detection fails |
| `ALLOW_PASSWORD_LOGIN` | _(unset)_ | `1` = break-glass: password sign-in works even if switched off |

## Discord bot setup

1. Create a **new application** at <https://discord.com/developers/applications>. Keep it separate from Stormsmith's bot, so neither bot overwrites the other's guild commands.
2. **Bot** tab → reset/copy the token, and turn on **Message Content Intent**. It's only needed for request-thread → Vikunja sync; if you turn sync off, StormWarden won't request it.
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`. Permissions: Send Messages, Embed Links, Attach Files, Add Reactions, Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads. Invite it to your server.
4. In StormWarden → **Discord Bot**: paste the token and the server (guild) ID, tick *Bot enabled*, and save. Pick your Warden admin roles and, optionally, an activity-log channel.

Commands are registered as **guild** commands, so changes show up within seconds.

## Vikunja setup

1. Create a dedicated **StormWarden** user in Vikunja. Registration is off on your instance, so use the Vikunja CLI: `vikunja user create`.
2. **Share each request project with that user with *write* access**, since moving a task between Kanban columns needs write access.
3. Signed in as that user, go to **Settings → API Tokens** and create a token with: Projects *read*, Project views/buckets *read* and *update*, Tasks *create/read/update*, Task comments *create/read*, Labels *read*, Task labels *create/delete*.
4. **Labels:** Vikunja only shows a user its own labels, plus labels already used on tasks in projects shared with it. Either create the triage labels you want (Bug, Feature, …) while signed in as the StormWarden user, or make sure they're already on a task in each shared project.
5. StormWarden → **Requests**: enter the Vikunja URL (`https://projects.stormconnect.ca`) and the token, then **Save & test**.
6. **Add project** (one per container):
   - The **container** (fills in the name and key)
   - The **Vikunja project**
   - The **thread channel**: a forum channel gets one post per request; a text channel gets a message plus a thread
   - The **triage labels** to offer (max 25)
   - **Who can request**: the roles or people. Empty means admins only.

Each new request thread gets a **🗂️ Triage** panel with two dropdowns, filled from Vikunja: the project's Kanban columns (the task starts in the default column) and the labels. Only Warden admins can use them. Changes apply to the task right away, and the panel updates to show the current state. Adding or removing labels only touches the labels the panel offers, so labels you add directly in Vikunja are left alone.

StormWarden targets Vikunja's **`/api/v2`** (Vikunja ≥ 2.4). If a route isn't there, it automatically retries the `/api/v1` form, so older instances work too.

Sync details:
- Discord → Vikunja happens instantly. Each mirrored message gets a 📨 reaction, or ⚠️ if Vikunja refused it. Attachments are linked.
- Vikunja → Discord is polled every 60s, or on demand with **Requests → Sync now**. Comments created *by* the sync are tracked by id, so nothing echoes.
- Comments made through the API token show up in Vikunja as the token's owner, with the Discord author's name in bold at the top.

## Development

```sh
npm install
npm run dev        # backend on :8090
npm run dev:web    # frontend on :5173 (proxies /api to :8090)
npm run build      # web + server
npm start
```

On Windows, point the backend at StormTower's Docker with `DOCKER_HOST=tcp://192.168.10.35:2375` (enable Unraid's Docker remote API first).
