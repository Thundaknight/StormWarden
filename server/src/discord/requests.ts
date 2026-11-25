import {
  ActionRowBuilder, ChannelType, Client, EmbedBuilder, StringSelectMenuBuilder, ForumChannel, GuildMember, Message, NewsChannel, TextChannel, ThreadChannel,
} from 'discord.js';
import { config } from '../config';
import {
  audit, createRequest, getProjectMap, getRequest, getRequestByThread, getSettings, isCommentSynced, listOpenSyncedRequests,
  markCommentSynced, setRequestDone, setRequestThread, setRequestTriage,
} from '../db';
import type { FeatureRequest, VikunjaProjectMap } from '../types';
import { htmlToText, textToHtml, escapeHtml, vikunja } from '../vikunja';

const COLOR_REQUEST = 0x3aa8ff;
const COLOR_VIKUNJA = 0x8f6bff;
const COLOR_DONE = 0x3fc97c;

/**
 * /request → Vikunja task + Discord thread, with two-way comment mirroring.
 *
 *  Discord → Vikunja: every non-bot message in a request thread becomes a task comment
 *    (needs the Message Content intent). The new comment's id is recorded so polling never echoes it back.
 *  Vikunja → Discord: a poll (default 60s) lists comments on each open request's task and posts any
 *    comment id we haven't seen. When the task is marked done, the thread gets a closing note and is archived.
 */
class RequestSync {
  private client: Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  isConfigured(): boolean {
    return vikunja.isConfigured();
  }

  start(client: Client): void {
    this.client = client;
    this.stop();
    if (!getSettings().vikunja_sync_enabled) return;
    this.timer = setInterval(() => this.poll().catch((e) => console.error('[requests] poll failed:', e?.message || e)), config.vikunjaPollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async createRequest(opts: {
    project: VikunjaProjectMap; member: GuildMember; title: string; description: string; fallbackChannelId: string;
  }): Promise<{ request: FeatureRequest; taskLabel: string; threadUrl: string }> {
    const { project, member, title, description } = opts;
    const who = `${member.displayName} (@${member.user.username})`;
    const html = (description ? textToHtml(description) : '')
      + `<p><em>Requested by ${escapeHtml(who)} via Discord (StormWarden).</em></p>`;
    const task = await vikunja.createTask(project.vikunja_project_id, title, html);
    const taskLabel = task.identifier || String(task.index ?? task.id);

    const request = createRequest({
      project_map_id: project.id, vikunja_task_id: task.id, thread_id: '',
      requester_id: member.id, requester_name: member.user.username, title,
    });
    audit(member.user.username, 'discord', 'request.create', project.display_name, `task ${task.id}: ${title}`);

    let threadUrl = '';
    let threadId = '';
    try {
      const thread = await this.openThread(project, member, title, description, task.id, taskLabel, opts.fallbackChannelId);
      if (thread) {
        setRequestThread(request.id, thread.id);
        threadId = thread.id;
        threadUrl = thread.url;
        await this.postTriage(request.id, thread).catch((err) =>
          console.warn('[requests] triage message failed:', err?.message || err));
      }
    } catch (err: any) {
      console.warn('[requests] could not open thread:', err?.message || err);
    }
    return { request: { ...request, thread_id: threadId }, taskLabel, threadUrl };
  }

  private async openThread(
    project: VikunjaProjectMap, member: GuildMember, title: string, description: string,
    taskId: number, taskLabel: string, fallbackChannelId: string,
  ): Promise<ThreadChannel | null> {
    if (!this.client) return null;
    const channelId = project.channel_id || fallbackChannelId;
    const ch = channelId ? await this.client.channels.fetch(channelId).catch(() => null) : null;
    if (!ch) return null;

    const embed = new EmbedBuilder()
      .setColor(COLOR_REQUEST)
      .setTitle(`📝 ${title}`.slice(0, 256))
      .setURL(vikunja.taskUrl(taskId))
      .setDescription(description ? description.slice(0, 4000) : '*No details given.*')
      .addFields(
        { name: 'Project', value: project.display_name, inline: true },
        { name: 'Requested by', value: `${member}`, inline: true },
        { name: 'Vikunja task', value: `[#${taskLabel}](${vikunja.taskUrl(taskId)})`, inline: true },
      )
      .setFooter({ text: 'Replies in this thread are copied to Vikunja, and Vikunja comments are posted here.' });
    const name = `[${project.key}] ${title}`.slice(0, 100);

    let thread: ThreadChannel;
    if (ch.type === ChannelType.GuildForum) {
      thread = await (ch as ForumChannel).threads.create({ name, message: { embeds: [embed] } });
    } else if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
      const starter = await (ch as TextChannel | NewsChannel).send({ embeds: [embed] });
      thread = await starter.startThread({ name });
    } else {
      return null; // e.g. /request was used inside a thread and no channel is configured
    }
    await thread.members.add(member.id).catch(() => {});
    return thread;
  }

  // ---------------------------------------------------------------- triage (Kanban bucket + labels)

  /** Posts the admin-only triage panel into a new request thread. */
  private async postTriage(requestId: number, thread: ThreadChannel): Promise<void> {
    const req = getRequest(requestId)!;
    const project = getProjectMap(req.project_map_id)!;
    const view = await vikunja.getKanbanView(project.vikunja_project_id).catch(() => null);
    if (view?.default_bucket_id) setRequestTriage(requestId, { bucket_id: view.default_bucket_id });
    const panel = await this.renderTriage(requestId);
    const msg = await thread.send(panel);
    setRequestTriage(requestId, { triage_message_id: msg.id });
  }

  /** Builds the triage panel from live Vikunja state (bucket list, labels, the task's current labels). */
  async renderTriage(requestId: number): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder>[] }> {
    const req = getRequest(requestId);
    if (!req) throw new Error('Request not found');
    const project = getProjectMap(req.project_map_id);
    if (!project) throw new Error('Request project was deleted');

    const [view, task, allLabels] = await Promise.all([
      vikunja.getKanbanView(project.vikunja_project_id).catch(() => null),
      vikunja.getTask(req.vikunja_task_id),
      vikunja.listLabels().catch(() => []),
    ]);
    const buckets = view ? await vikunja.listBuckets(project.vikunja_project_id, view.id).catch(() => []) : [];
    let allowed: number[] = [];
    try { allowed = JSON.parse(project.label_ids || '[]'); } catch { /* all */ }
    const labels = (allowed.length ? allLabels.filter((l) => allowed.includes(l.id)) : allLabels).slice(0, 25);
    const current = new Set((task.labels || []).map((l) => l.id));
    const bucketId = req.bucket_id || view?.default_bucket_id || 0;

    const embed = new EmbedBuilder()
      .setColor(0xffd23f)
      .setTitle('🗂️ Triage')
      .setDescription('StormWarden admins: pick a Kanban column and labels. Changes apply to the Vikunja task immediately.')
      .addFields(
        { name: 'Column', value: buckets.find((b) => b.id === bucketId)?.title || '—', inline: true },
        { name: 'Labels', value: (task.labels || []).map((l) => l.title).join(', ') || '—', inline: true },
      );

    const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
    if (buckets.length) {
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`sw:tb:${req.id}`).setPlaceholder('Kanban column…')
          .addOptions(buckets.slice(0, 25).map((b) => ({ label: b.title.slice(0, 100), value: String(b.id), default: b.id === bucketId }))),
      ));
    } else {
      embed.setFooter({ text: 'This project has no Kanban view, so there are no columns to pick.' });
    }
    if (labels.length) {
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`sw:tl:${req.id}`).setPlaceholder('Labels…')
          .setMinValues(0).setMaxValues(labels.length)
          .addOptions(labels.map((l) => ({ label: l.title.slice(0, 100), value: String(l.id), default: current.has(l.id) }))),
      ));
    }
    return { embeds: [embed], components: rows };
  }

  /** Applies a triage selection to Vikunja, then returns the refreshed panel. */
  async applyTriage(requestId: number, change: { bucketId?: number; labelIds?: number[] }, actor: string) {
    const req = getRequest(requestId);
    if (!req) throw new Error('Request not found');
    const project = getProjectMap(req.project_map_id);
    if (!project) throw new Error('Request project was deleted');

    if (change.bucketId) {
      const view = await vikunja.getKanbanView(project.vikunja_project_id);
      if (!view) throw new Error('Project has no Kanban view');
      await vikunja.moveToBucket(project.vikunja_project_id, view.id, change.bucketId, req.vikunja_task_id);
      setRequestTriage(requestId, { bucket_id: change.bucketId });
      audit(actor, 'discord', 'request.triage.column', req.title, `bucket ${change.bucketId}`);
    }
    if (change.labelIds) {
      const task = await vikunja.getTask(req.vikunja_task_id);
      const have = new Set((task.labels || []).map((l) => l.id));
      const want = new Set(change.labelIds);
      // Only touch labels this panel offers, so labels added in Vikunja outside that list survive.
      let offered: number[] = [];
      try { offered = JSON.parse(project.label_ids || '[]'); } catch { /* all */ }
      const inScope = (id: number) => !offered.length || offered.includes(id);
      for (const id of want) if (!have.has(id)) await vikunja.addLabel(req.vikunja_task_id, id);
      for (const id of have) if (!want.has(id) && inScope(id)) await vikunja.removeLabel(req.vikunja_task_id, id);
      audit(actor, 'discord', 'request.triage.labels', req.title, [...want].join(','));
    }
    return this.renderTriage(requestId);
  }

  /** Discord → Vikunja. */
  async onThreadMessage(m: Message): Promise<void> {
    if (m.author.bot || m.system || !m.channel.isThread()) return;
    if (!getSettings().vikunja_sync_enabled || !vikunja.isConfigured()) return;
    const req = getRequestByThread(m.channel.id);
    if (!req || req.done) return;

    const name = m.member?.displayName || m.author.username;
    let html = `<p><strong>${escapeHtml(name)}</strong> (Discord):</p>`;
    if (m.content) html += textToHtml(m.content);
    for (const a of m.attachments.values()) {
      html += `<p>📎 <a href="${escapeHtml(a.url)}">${escapeHtml(a.name || 'attachment')}</a></p>`;
    }
    if (!m.content && !m.attachments.size) return;
    try {
      const comment = await vikunja.addComment(req.vikunja_task_id, html);
      markCommentSynced(comment.id, req.id, m.id, 'to_vikunja');
      await m.react('📨').catch(() => {});
    } catch (err: any) {
      console.warn('[requests] comment → Vikunja failed:', err?.message || err);
      await m.react('⚠️').catch(() => {});
    }
  }

  /** Vikunja → Discord. Exposed so the web UI can trigger a sync on demand. */
  async poll(): Promise<{ checked: number; posted: number; closed: number }> {
    const stats = { checked: 0, posted: 0, closed: 0 };
    if (this.polling || !this.client?.isReady() || !vikunja.isConfigured()) return stats;
    this.polling = true;
    try {
      for (const req of listOpenSyncedRequests()) {
        stats.checked++;
        const thread = await this.client.channels.fetch(req.thread_id).catch((err) => {
          // Unknown Channel → thread was deleted; stop tracking it
          if (err?.code === 10003) setRequestThread(req.id, '');
          return null;
        });
        if (!thread || !thread.isThread()) continue;

        let comments;
        try {
          comments = await vikunja.listComments(req.vikunja_task_id);
        } catch (err: any) {
          console.warn(`[requests] listing comments for task ${req.vikunja_task_id} failed:`, err?.message || err);
          continue;
        }
        for (const c of comments.sort((a, b) => a.id - b.id)) {
          if (isCommentSynced(c.id)) continue;
          const text = htmlToText(c.comment || '');
          const author = c.author?.name || c.author?.username || 'Vikunja';
          const embed = new EmbedBuilder()
            .setColor(COLOR_VIKUNJA)
            .setAuthor({ name: `${author} · Vikunja` })
            .setDescription(text.slice(0, 4000) || '*(empty comment)*');
          if (thread.archived) await thread.setArchived(false).catch(() => {});
          const sent = await thread.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
          if (sent) {
            markCommentSynced(c.id, req.id, sent.id, 'to_discord');
            stats.posted++;
          }
        }

        const task = await vikunja.getTask(req.vikunja_task_id).catch(() => null);
        if (task?.done) {
          setRequestDone(req.id, true);
          const project = getProjectMap(req.project_map_id);
          await thread.send({
            embeds: [new EmbedBuilder().setColor(COLOR_DONE)
              .setDescription(`✅ Marked **done** in Vikunja${project ? ` (${project.display_name})` : ''}. Thanks <@${req.requester_id}>!`)],
            allowedMentions: { users: [req.requester_id] },
          }).catch(() => {});
          await thread.setArchived(true).catch(() => {});
          stats.closed++;
        }
      }
    } finally {
      this.polling = false;
    }
    return stats;
  }
}

export const requestSync = new RequestSync();
