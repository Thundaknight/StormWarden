import {
  ActionRowBuilder, AttachmentBuilder, AutocompleteInteraction, ButtonBuilder, ButtonInteraction, ButtonStyle,
  ChannelType, ChatInputCommandInteraction, Client, EmbedBuilder, GatewayIntentBits, GuildMember, Interaction,
  Message, ModalBuilder, ModalSubmitInteraction, REST, Routes, SlashCommandBuilder, StringSelectMenuInteraction,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import crypto from 'crypto';
import {
  audit, getContainer, getProjectMap, getScript, getScriptByCommand, getSettings, listScriptGrants, listScripts,
} from '../db';
import { getPermAccessToken } from '../discordOAuth';
import { getSelfContainerName, getStormsmithContainers } from '../guard';
import { getStates, getUptimeStart, performAction, type ContainerAction, type ContainerState } from '../docker';
import { isScriptRunning, parseOptions, runScript, type RunResult } from '../scriptRunner';
import type { Script } from '../types';
import { canContainer, canRequest, canRunScript, containersFor, isWardenAdmin, projectsFor } from './perms';
import { requestSync } from './requests';

const STATE_EMOJI: Record<ContainerState, string> = {
  running: '🟢', paused: '🟡', restarting: '🔄', exited: '🔴', created: '⚪', dead: '💀', removing: '🗑️', not_found: '❓',
};

type OutputSink = (payload: { content?: string; embeds?: EmbedBuilder[]; files?: AttachmentBuilder[] }) => Promise<void>;

const COLOR = { running: 0xffd23f, success: 0x3fc97c, failed: 0xff4d4d, info: 0x3aa8ff };

/** Script invocations awaiting their confirm button (holds the chosen option values). */
interface PendingRun { scriptId: number; userId: string; options: Record<string, string>; expires: number }

/** Interaction tokens last 15 min; stop using editReply a little before that. */
const TOKEN_SAFE_MS = 14 * 60_000;

function codeBlock(text: string, max: number): string {
  let t = text.replace(/```/g, '`​``').trimEnd();
  if (t.length > max) t = '…' + t.slice(t.length - max + 1);
  return '```\n' + (t || ' ') + '\n```';
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return '—';
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor(ms / 3_600_000) % 24;
  const m = Math.floor(ms / 60_000) % 60;
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
}

class DiscordBot {
  client: Client | null = null;
  lastError = '';
  /** Result of the last script-command visibility sync, shown on the Discord page. */
  permSync = { ok: false, message: 'Not synced yet', at: '' };
  private commandRefreshTimer: NodeJS.Timeout | null = null;
  private pending = new Map<string, PendingRun>();

  isRunning(): boolean {
    return !!this.client?.isReady();
  }

  status() {
    return { running: this.isRunning(), error: this.lastError, permSync: this.permSync };
  }

  async start(): Promise<void> {
    const s = getSettings();
    this.lastError = '';
    if (!s.discord_enabled || !s.discord_bot_token || !s.discord_guild_id) return;

    // Message Content is privileged and only needed to mirror thread replies into Vikunja.
    const intents = [GatewayIntentBits.Guilds];
    if (s.vikunja_sync_enabled) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);

    const client = new Client({ intents });
    this.client = client;
    client.on('interactionCreate', (i) => {
      this.handleInteraction(i).catch((err) => console.error('[discord] interaction error:', err));
    });
    client.on('messageCreate', (m) => {
      requestSync.onThreadMessage(m).catch((err) => console.error('[discord] thread sync error:', err));
    });

    try {
      await client.login(s.discord_bot_token);
      await new Promise<void>((resolve) => (client.isReady() ? resolve() : client.once('ready', () => resolve())));
      await this.registerCommands();
    } catch (err: any) {
      let msg = err?.message || String(err);
      if (/disallowed intents/i.test(msg)) {
        msg += ' — enable "Message Content Intent" for the bot in the Discord Developer Portal, '
          + 'or turn off Vikunja thread sync.';
      }
      this.lastError = msg;
      console.error('[discord] failed to start bot:', msg);
      await this.stop();
      return;
    }
    requestSync.start(client);
    console.log(`[discord] logged in as ${client.user?.tag}`);
  }

  async stop(): Promise<void> {
    requestSync.stop();
    if (this.client) {
      await this.client.destroy().catch(() => {});
      this.client = null;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Debounced re-registration after scripts are added/renamed/removed in the web UI. */
  queueCommandRefresh(): void {
    if (!this.isRunning()) return;
    if (this.commandRefreshTimer) clearTimeout(this.commandRefreshTimer);
    this.commandRefreshTimer = setTimeout(() => {
      this.registerCommands().catch((err) => {
        this.lastError = `Command registration failed: ${err?.message || err}`;
        console.error('[discord]', this.lastError);
      });
    }, 1500);
  }

  // ---------------------------------------------------------------- guild metadata for the web UI

  async getGuildMeta(): Promise<{
    guildName: string;
    roles: Array<{ id: string; name: string; color: string }>;
    channels: Array<{ id: string; name: string; type: 'text' | 'forum' | 'announcement' }>;
  }> {
    const empty = { guildName: '', roles: [], channels: [] };
    const gid = getSettings().discord_guild_id;
    if (!this.client?.isReady() || !gid) return empty;
    const guild = await this.client.guilds.fetch(gid);
    const roles = await guild.roles.fetch();
    const channels = await guild.channels.fetch();
    return {
      guildName: guild.name,
      roles: roles
        .filter((r) => r.id !== guild.id && !r.managed)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
      channels: channels
        .filter((c): c is NonNullable<typeof c> => !!c && [ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildAnnouncement].includes(c.type))
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type === ChannelType.GuildForum ? 'forum' as const : c.type === ChannelType.GuildAnnouncement ? 'announcement' as const : 'text' as const,
        })),
    };
  }

  async lookupMember(idOrQuery: string): Promise<Array<{ id: string; name: string }>> {
    const gid = getSettings().discord_guild_id;
    if (!this.client?.isReady() || !gid) return [];
    const guild = await this.client.guilds.fetch(gid);
    if (/^\d{15,22}$/.test(idOrQuery)) {
      const m = await guild.members.fetch(idOrQuery).catch(() => null);
      return m ? [{ id: m.id, name: m.displayName + ` (@${m.user.username})` }] : [];
    }
    const found = await guild.members.search({ query: idOrQuery, limit: 10 }).catch(() => null);
    return found ? [...found.values()].map((m) => ({ id: m.id, name: m.displayName + ` (@${m.user.username})` })) : [];
  }

  // ---------------------------------------------------------------- command registration

  private async registerCommands(): Promise<void> {
    const s = getSettings();
    if (!this.client?.application || !s.discord_guild_id) return;

    const containerOpt = (o: any, desc = 'Container') =>
      o.setName('container').setDescription(desc).setRequired(true).setAutocomplete(true);

    const docker = new SlashCommandBuilder()
      .setName('docker')
      .setDescription('Manage StormTower containers you have access to')
      .setDMPermission(false)
      .addSubcommand((sc) => sc.setName('status').setDescription('Show container status')
        .addStringOption((o) => o.setName('container').setDescription('A specific container (leave empty for all)').setAutocomplete(true)))
      .addSubcommand((sc) => sc.setName('start').setDescription('Start a container').addStringOption((o) => containerOpt(o)))
      .addSubcommand((sc) => sc.setName('stop').setDescription('Stop a container').addStringOption((o) => containerOpt(o)))
      .addSubcommand((sc) => sc.setName('restart').setDescription('Restart a container').addStringOption((o) => containerOpt(o)));

    const request = new SlashCommandBuilder()
      .setName('request')
      .setDescription('Request a feature or report an issue for a project')
      .setDMPermission(false)
      .addStringOption((o) => o.setName('project').setDescription('Which project').setRequired(true).setAutocomplete(true));

    // Script commands are hidden from everyone but Discord admins (default_member_permissions = 0);
    // syncCommandPermissions() then reveals each one to exactly the roles/users granted in the web UI.
    const scriptCmds = listScripts().filter((sc) => sc.enabled).map((sc) => {
      const b = new SlashCommandBuilder()
        .setName(sc.command_name)
        .setDescription((sc.description || `Run the ${sc.command_name} script`).slice(0, 100))
        .setDMPermission(false)
        .setDefaultMemberPermissions(0);
      for (const opt of parseOptions(sc)) {
        b.addStringOption((o) => o.setName(opt.name).setDescription(opt.description.slice(0, 100) || opt.name)
          .setRequired(opt.required)
          .addChoices(...opt.choices.map((c) => ({ name: c.label.slice(0, 100), value: c.value }))));
      }
      return b;
    });

    const body = [docker, request, ...scriptCmds].map((c) => c.toJSON());
    const rest = new REST({ version: '10' }).setToken(s.discord_bot_token);
    const registered = await rest.put(Routes.applicationGuildCommands(this.client.application.id, s.discord_guild_id), { body }) as Array<{ id: string; name: string }>;
    console.log(`[discord] registered ${body.length} guild commands`);
    await this.syncCommandPermissions(registered);
  }

  /**
   * Makes each hidden script command visible to the roles/users granted it (plus Warden admin roles).
   * Discord only accepts this from a guild manager's OAuth token with the
   * applications.commands.permissions.update scope — authorised once from the Discord page.
   */
  private async syncCommandPermissions(registered: Array<{ id: string; name: string }>): Promise<void> {
    const s = getSettings();
    const at = new Date().toISOString();
    const token = await getPermAccessToken();
    if (!token) {
      this.permSync = { ok: false, at, message: 'Not authorised — script commands are visible to Discord admins only until you authorise command-permission sync.' };
      return;
    }
    const appId = this.client!.application!.id;
    const failures: string[] = [];
    let synced = 0;
    for (const sc of listScripts().filter((x) => x.enabled)) {
      const cmd = registered.find((r) => r.name === sc.command_name);
      if (!cmd) continue;
      const perms = new Map<string, { id: string; type: 1 | 2; permission: true }>();
      for (const r of s.discord_admin_role_ids) perms.set(r, { id: r, type: 1, permission: true });
      for (const g of listScriptGrants(sc.id)) perms.set(g.subject_id, { id: g.subject_id, type: g.subject_type === 'role' ? 1 : 2, permission: true });
      const res = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${s.discord_guild_id}/commands/${cmd.id}/permissions`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: [...perms.values()].slice(0, 100) }),
        signal: AbortSignal.timeout(10_000),
      }).catch((err) => ({ ok: false, status: 0, text: async () => String(err) }) as any);
      if (res.ok) synced++;
      else failures.push(`/${sc.command_name}: ${res.status} ${(await res.text()).slice(0, 120)}`);
    }
    this.permSync = failures.length
      ? { ok: false, at, message: `Synced ${synced}, failed ${failures.length}: ${failures.join('; ')}` }
      : { ok: true, at, message: `Visibility synced for ${synced} script command${synced === 1 ? '' : 's'}.` };
    if (failures.length) console.warn('[discord] command permission sync:', this.permSync.message);
  }

  // ---------------------------------------------------------------- dispatch

  private async handleInteraction(i: Interaction): Promise<void> {
    if (!i.inGuild() || i.guildId !== getSettings().discord_guild_id) return;
    if (i.isAutocomplete()) return this.handleAutocomplete(i);
    if (i.isChatInputCommand()) {
      if (i.commandName === 'docker') return this.handleDocker(i);
      if (i.commandName === 'request') return this.handleRequestCommand(i);
      const script = getScriptByCommand(i.commandName);
      if (script) return this.handleScriptCommand(i, script);
      await i.reply({ content: 'That command is no longer configured.', ephemeral: true });
      return;
    }
    if (i.isButton()) return this.handleButton(i);
    if (i.isStringSelectMenu()) return this.handleSelect(i);
    if (i.isModalSubmit()) return this.handleModal(i);
  }

  private async member(i: Interaction): Promise<GuildMember | null> {
    if (i.member instanceof GuildMember) return i.member;
    if (!i.guild) return null;
    return i.guild.members.fetch(i.user.id).catch(() => null);
  }

  /** Containers a member may use, minus StormWarden itself and anything Stormsmith manages. */
  private async usableContainers(member: GuildMember, kind: 'view' | 'control') {
    const self = await getSelfContainerName();
    const ss = getStormsmithContainers().names;
    return containersFor(member, kind).filter((c) => c.container_name !== self && !ss.has(c.container_name));
  }

  private async handleAutocomplete(i: AutocompleteInteraction): Promise<void> {
    const member = await this.member(i);
    if (!member) return i.respond([]);
    const focused = i.options.getFocused(true);
    const q = String(focused.value).toLowerCase();

    if (i.commandName === 'docker' && focused.name === 'container') {
      const sub = i.options.getSubcommand();
      const kind = sub === 'status' ? 'view' : 'control';
      const list = (await this.usableContainers(member, kind))
        .filter((c) => !q || c.display_name.toLowerCase().includes(q) || c.container_name.toLowerCase().includes(q))
        .slice(0, 25)
        .map((c) => ({ name: `${c.display_name} (${c.container_name})`.slice(0, 100), value: String(c.id) }));
      return i.respond(list);
    }
    if (i.commandName === 'request' && focused.name === 'project') {
      const list = projectsFor(member)
        .filter((p) => !q || p.display_name.toLowerCase().includes(q) || p.key.includes(q))
        .slice(0, 25)
        .map((p) => ({ name: p.display_name.slice(0, 100), value: String(p.id) }));
      return i.respond(list);
    }
    return i.respond([]);
  }

  // ---------------------------------------------------------------- /docker

  private async handleDocker(i: ChatInputCommandInteraction): Promise<void> {
    const member = await this.member(i);
    if (!member) return void i.reply({ content: 'Could not resolve your server membership.', ephemeral: true });
    const sub = i.options.getSubcommand();
    const raw = i.options.getString('container');
    const container = raw ? getContainer(parseInt(raw, 10)) : undefined;
    if (raw && !container) return void i.reply({ content: 'Unknown container — pick one from the list.', ephemeral: true });

    if (sub === 'status') {
      if (container) {
        if (!canContainer(member, container.id, 'view')) return void this.denied(i);
        await i.deferReply();
        const st = (await getStates([container.container_name])).get(container.container_name)!;
        const embed = new EmbedBuilder()
          .setTitle(`${STATE_EMOJI[st.state]} ${container.display_name}`)
          .setColor(st.state === 'running' ? COLOR.success : st.state === 'not_found' || st.state === 'exited' ? COLOR.failed : COLOR.running)
          .setDescription(container.description || null)
          .addFields(
            { name: 'State', value: st.state, inline: true },
            { name: 'Uptime', value: formatUptime(await getUptimeStart(container.container_name)), inline: true },
            { name: 'Container', value: `\`${container.container_name}\``, inline: true },
            { name: 'Status', value: st.status || '—' },
          );
        return void i.editReply({ embeds: [embed] });
      }
      const visible = await this.usableContainers(member, 'view');
      if (!visible.length) return void i.reply({ content: 'You don\'t have access to any containers.', ephemeral: true });
      await i.deferReply();
      const states = await getStates(visible.map((c) => c.container_name));
      const lines = visible.map((c) => {
        const st = states.get(c.container_name)!;
        return `${STATE_EMOJI[st.state]} **${c.display_name}** — ${st.status || st.state}`;
      });
      const embed = new EmbedBuilder().setTitle('StormTower containers').setColor(COLOR.info)
        .setDescription(lines.join('\n').slice(0, 4000));
      return void i.editReply({ embeds: [embed] });
    }

    if (!container) return void i.reply({ content: 'Pick a container.', ephemeral: true });

    // start / stop / restart
    if (!canContainer(member, container.id, 'control')) return void this.denied(i);
    const action = sub as ContainerAction;
    if (action === 'stop') {
      // Stopping is the one action that leaves something down — confirm it.
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`sw:stop:${container.id}:${member.id}`).setLabel(`Stop ${container.display_name}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`sw:cancel:${member.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      return void i.reply({ content: `Stop **${container.display_name}**?`, components: [row], ephemeral: true });
    }
    await i.deferReply();
    await this.doContainerAction(container.id, action, member, (content) => i.editReply({ content }));
  }

  private async doContainerAction(
    containerId: number, action: ContainerAction, member: GuildMember, reply: (content: string) => Promise<unknown>,
  ): Promise<void> {
    const c = getContainer(containerId);
    if (!c) return void reply('That container is no longer managed.');
    const verb = { start: 'Started', stop: 'Stopped', restart: 'Restarted' }[action];
    try {
      await performAction(c.container_name, action);
      audit(member.user.username, 'discord', `container.${action}`, c.container_name);
      await reply(`✅ ${verb} **${c.display_name}** (requested by ${member})`);
      this.postLog(`🐳 **${member.displayName}** ${verb.toLowerCase()} **${c.display_name}**`);
    } catch (err: any) {
      audit(member.user.username, 'discord', `container.${action}.failed`, c.container_name, err?.message || String(err));
      await reply(`❌ Could not ${action} **${c.display_name}**: ${err?.message || err}`);
      if (err?.statusCode !== 403) {
        this.postLog(`🐳 **${member.displayName}** tried to ${action} **${c.display_name}** — failed: ${err?.message || err}`, true);
      }
    }
  }

  // ---------------------------------------------------------------- script commands

  private async handleScriptCommand(i: ChatInputCommandInteraction, script: Script): Promise<void> {
    const member = await this.member(i);
    if (!member) return void i.reply({ content: 'Could not resolve your server membership.', ephemeral: true });
    if (!script.enabled) return void i.reply({ content: `/${script.command_name} is disabled.`, ephemeral: true });
    if (!canRunScript(member, script)) return void this.denied(i);
    const busy = isScriptRunning(script.id);
    if (busy) {
      return void i.reply({ content: `⏳ /${script.command_name} is already running (started by ${busy.actor}, run #${busy.runId}).`, ephemeral: true });
    }
    const options: Record<string, string> = {};
    for (const opt of parseOptions(script)) {
      const v = i.options.getString(opt.name);
      if (v) options[opt.name] = v;
    }
    const optText = this.describeOptions(script, options);

    if (script.require_confirm) {
      // Button custom ids are capped at 100 chars, so the chosen options wait server-side under a nonce.
      const nonce = crypto.randomBytes(6).toString('hex');
      this.pending.set(nonce, { scriptId: script.id, userId: member.id, options, expires: Date.now() + 10 * 60_000 });
      for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`sw:run:${nonce}:${member.id}`).setLabel(`Run /${script.command_name}`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`sw:cancel:${member.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      return void i.reply({
        content: `**/${script.command_name}** — ${script.description || 'run this script'}${optText ? `\n${optText}` : ''}\nRun it now?`,
        components: [row], ephemeral: true,
      });
    }

    await i.deferReply({ ephemeral: !!script.ephemeral_output });
    await this.executeScript(script, member, this.replySink(i, !!script.ephemeral_output), options);
  }

  private describeOptions(script: Script, options: Record<string, string>): string {
    return parseOptions(script)
      .filter((o) => options[o.name])
      .map((o) => `**${o.name}:** ${o.choices.find((c) => c.value === options[o.name])?.label || options[o.name]}`)
      .join(' · ');
  }

  /** Where a run's live output goes: the interaction reply, or a fresh message in the channel. */
  private replySink(i: ChatInputCommandInteraction | ButtonInteraction, ephemeral: boolean): OutputSink {
    const t0 = Date.now();
    let msg: Message | null = null;
    return async (payload) => {
      // Public replies are edited as normal messages once we have them (no 15-min token limit).
      if (msg && !ephemeral) { await msg.edit(payload); return; }
      if (ephemeral && Date.now() - t0 > TOKEN_SAFE_MS) return; // token expired; web UI has the full log
      msg = (await i.editReply({ content: '', components: [], ...payload })) as Message;
    };
  }

  private channelSink(i: ButtonInteraction): OutputSink | null {
    const ch = i.channel;
    if (!ch || !ch.isTextBased() || !('send' in ch)) return null;
    let msg: Message | null = null;
    return async (payload) => {
      if (msg) { await msg.edit(payload); return; }
      msg = await ch.send({ ...payload, allowedMentions: { parse: [] } });
    };
  }

  /** Runs a script and streams its output into a Discord embed, re-rendered every ~1.5s. */
  private async executeScript(script: Script, member: GuildMember, sink: OutputSink, options: Record<string, string> = {}): Promise<void> {
    const t0 = Date.now();
    const optText = this.describeOptions(script, options);
    const render = (output: string, result?: RunResult) => {
      const status = result ? result.status : 'running';
      const icon = { running: '⏳', success: '✅', failed: '❌', timeout: '⌛', error: '⚠️' }[status];
      const embed = new EmbedBuilder()
        .setTitle(`${icon} /${script.command_name} — ${status}`)
        .setColor(status === 'running' ? COLOR.running : status === 'success' ? COLOR.success : COLOR.failed)
        .setDescription(codeBlock(output || '(no output yet)', 3800))
        .addFields(
          { name: 'Run by', value: `${member}`, inline: true },
          { name: 'Duration', value: formatDuration(result ? result.durationMs : Date.now() - t0), inline: true },
        );
      if (optText) embed.addFields({ name: 'Options', value: optText.slice(0, 1000) });
      if (result) embed.addFields({ name: 'Exit code', value: String(result.exitCode ?? '—'), inline: true });
      return embed;
    };
    const safe = (p: Parameters<OutputSink>[0]) => sink(p).catch((err) =>
      console.warn('[discord] could not update script output:', err?.message || err));

    let started: { runId: number; done: Promise<RunResult> };
    let pending: Promise<void> = Promise.resolve();
    try {
      started = runScript(script, { name: member.user.username, id: member.id, source: 'discord' }, {
        options,
        onOutput: (out) => { pending = pending.then(() => safe({ embeds: [render(out)] })); },
      });
    } catch (err: any) {
      await safe({ content: `❌ ${err?.message || err}`, embeds: [] });
      return;
    }
    pending = pending.then(() => safe({ embeds: [render('')] }));
    const result = await started.done;
    await pending;
    const files = result.output.length > 3800
      ? [new AttachmentBuilder(Buffer.from(result.output, 'utf8'), { name: `${script.command_name}-run-${result.runId}.log` })]
      : [];
    await safe({ embeds: [render(result.output, result)], files });

    this.postRunLog(script, `**${member.displayName}**`, result);
  }

  /** Log-channel line for a finished run; failures ping the configured role/user. */
  postRunLog(script: Script, who: string, result: RunResult): void {
    const base = getSettings().web_base_url;
    const link = base ? ` · [output](${base}/scripts/${script.id}?run=${result.runId})` : '';
    const ok = result.status === 'success';
    this.postLog(`${ok ? '🛠️' : '🚨'} ${who} ran \`/${script.command_name}\` → **${result.status}** `
      + `(exit ${result.exitCode ?? '—'}, ${formatDuration(result.durationMs)}, run #${result.runId})${link}`, !ok);
  }

  // ---------------------------------------------------------------- buttons

  private async handleButton(i: ButtonInteraction): Promise<void> {
    const [ns, kind, a, b] = i.customId.split(':');
    if (ns !== 'sw') return;
    // Confirmation buttons belong to whoever ran the command.
    const owner = kind === 'cancel' ? a : b;
    if (owner && owner !== i.user.id) return void i.reply({ content: 'That button isn\'t yours.', ephemeral: true });

    if (kind === 'cancel') return void i.update({ content: 'Cancelled.', components: [] });

    const member = await this.member(i);
    if (!member) return void i.reply({ content: 'Could not resolve your server membership.', ephemeral: true });

    if (kind === 'stop') {
      const id = parseInt(a, 10);
      if (!canContainer(member, id, 'control')) return void i.update({ content: 'You no longer have permission for that.', components: [] });
      await i.update({ content: 'Stopping…', components: [] });
      return this.doContainerAction(id, 'stop', member, (content) => i.editReply({ content }));
    }

    if (kind === 'run') {
      const p = this.pending.get(a);
      this.pending.delete(a);
      const script = p ? getScript(p.scriptId) : undefined;
      if (!p || p.expires < Date.now()) return void i.update({ content: 'That confirmation expired — run the command again.', components: [] });
      if (!script || !script.enabled) return void i.update({ content: 'That script is no longer available.', components: [] });
      if (!canRunScript(member, script)) return void i.update({ content: 'You no longer have permission for that.', components: [] });
      if (isScriptRunning(script.id)) return void i.update({ content: `⏳ /${script.command_name} is already running.`, components: [] });
      if (script.ephemeral_output) {
        await i.update({ content: 'Starting…', components: [] });
        return this.executeScript(script, member, this.replySink(i, true), p.options);
      }
      // The confirm prompt was ephemeral; the run itself is posted publicly in the channel.
      await i.update({ content: `▶️ Started /${script.command_name} — output below.`, components: [] });
      const sink = this.channelSink(i) || this.replySink(i, true);
      return this.executeScript(script, member, sink, p.options);
    }
  }

  // ---------------------------------------------------------------- triage selects (request threads)

  private async handleSelect(i: StringSelectMenuInteraction): Promise<void> {
    const [ns, kind, reqId] = i.customId.split(':');
    if (ns !== 'sw' || (kind !== 'tb' && kind !== 'tl')) return;
    const member = await this.member(i);
    if (!member || !isWardenAdmin(member)) {
      return void i.reply({ content: '🚫 Only StormWarden admins can triage requests.', ephemeral: true });
    }
    await i.deferUpdate();
    try {
      const view = await requestSync.applyTriage(parseInt(reqId, 10), kind === 'tb'
        ? { bucketId: parseInt(i.values[0], 10) }
        : { labelIds: i.values.map((v) => parseInt(v, 10)) }, member.user.username);
      await i.editReply(view);
    } catch (err: any) {
      await i.followUp({ content: `❌ Vikunja update failed: ${err?.message || err}`, ephemeral: true });
    }
  }

  // ---------------------------------------------------------------- /request

  private async handleRequestCommand(i: ChatInputCommandInteraction): Promise<void> {
    const member = await this.member(i);
    if (!member) return void i.reply({ content: 'Could not resolve your server membership.', ephemeral: true });
    const project = getProjectMap(parseInt(i.options.getString('project', true), 10));
    if (!project || !project.enabled) return void i.reply({ content: 'Unknown project — pick one from the list.', ephemeral: true });
    if (!canRequest(member, project)) return void this.denied(i);
    if (!requestSync.isConfigured()) return void i.reply({ content: 'Requests aren\'t set up yet (Vikunja is not configured).', ephemeral: true });

    const modal = new ModalBuilder().setCustomId(`sw:req:${project.id}`).setTitle(`Request — ${project.display_name}`.slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(200).setPlaceholder('Short summary of the request')),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('description').setLabel('Details').setStyle(TextInputStyle.Paragraph)
          .setRequired(false).setMaxLength(3500).setPlaceholder('What should it do? Why? Steps to reproduce for bugs.')),
    );
    await i.showModal(modal);
  }

  private async handleModal(i: ModalSubmitInteraction): Promise<void> {
    const [ns, kind, a] = i.customId.split(':');
    if (ns !== 'sw' || kind !== 'req') return;
    const member = await this.member(i);
    const project = getProjectMap(parseInt(a, 10));
    if (!member || !project || !canRequest(member, project)) return void i.reply({ content: 'Request could not be submitted.', ephemeral: true });
    await i.deferReply({ ephemeral: true });
    try {
      const r = await requestSync.createRequest({
        project, member,
        title: i.fields.getTextInputValue('title').trim(),
        description: i.fields.getTextInputValue('description').trim(),
        fallbackChannelId: i.channelId || '',
      });
      await i.editReply({
        content: `✅ Request logged in **${project.display_name}** as task #${r.taskLabel}.`
          + (r.threadUrl ? `\nDiscuss it here: ${r.threadUrl} — replies sync to Vikunja.` : ''),
      });
    } catch (err: any) {
      await i.editReply({ content: `❌ Could not create the request: ${err?.message || err}` });
    }
  }

  // ---------------------------------------------------------------- helpers

  private async denied(i: ChatInputCommandInteraction): Promise<void> {
    await i.reply({ content: '🚫 You don\'t have permission to do that.', ephemeral: true });
  }

  /** Best-effort line in the optional log channel. `alert` prepends the configured failure ping. */
  postLog(content: string, alert = false): void {
    const s = getSettings();
    const id = s.discord_log_channel_id;
    if (!id || !this.client?.isReady()) return;
    const ping = alert ? s.discord_failure_ping : null;
    const mention = ping ? (ping.type === 'role' ? `<@&${ping.id}> ` : `<@${ping.id}> `) : '';
    const allowedMentions = ping ? (ping.type === 'role' ? { roles: [ping.id] } : { users: [ping.id] }) : { parse: [] as [] };
    this.client.channels.fetch(id)
      .then(async (ch) => {
        if (ch && ch.isTextBased() && 'send' in ch) await ch.send({ content: mention + content, allowedMentions });
      })
      .catch(() => {});
  }
}

export const discordBot = new DiscordBot();
