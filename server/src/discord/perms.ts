import { GuildMember, PermissionFlagsBits } from 'discord.js';
import {
  getSettings, listContainerGrants, listContainers, listProjectGrants, listProjectMaps, listScriptGrants,
} from '../db';
import type { ManagedContainer, Script, SubjectRef, VikunjaProjectMap } from '../types';

/**
 * Discord-side access model. Members can only view status and start/stop/restart containers;
 * anything beyond that (rebuilds, pulls, …) has to be an admin-authored script command.
 *
 * - "Warden admins" bypass every check: anyone with Discord's Administrator permission, the guild
 *   owner, or a member holding one of the roles listed in Settings → Discord → Admin roles.
 * - Everyone else needs a grant. A grant names either a role (any member holding it qualifies) or a
 *   single user id. Grants are additive: holding any matching grant is enough.
 */

export function isWardenAdmin(member: GuildMember): boolean {
  if (member.guild.ownerId === member.id) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const adminRoles = getSettings().discord_admin_role_ids;
  return adminRoles.some((r) => member.roles.cache.has(r));
}

export function matchesSubject(member: GuildMember, s: SubjectRef): boolean {
  if (s.subject_type === 'user') return s.subject_id === member.id;
  return member.roles.cache.has(s.subject_id);
}

export type ContainerPerm = 'view' | 'control';

export function canContainer(member: GuildMember, containerId: number, kind: ContainerPerm): boolean {
  if (isWardenAdmin(member)) return true;
  return listContainerGrants(containerId).some((g) => matchesSubject(member, g) && (
    kind === 'view' ? !!(g.can_view || g.can_control) : !!g.can_control
  ));
}

export function containersFor(member: GuildMember, kind: ContainerPerm): ManagedContainer[] {
  return listContainers().filter((c) => canContainer(member, c.id, kind));
}

export function canRunScript(member: GuildMember, script: Script): boolean {
  if (isWardenAdmin(member)) return true;
  return listScriptGrants(script.id).some((g) => matchesSubject(member, g));
}

/** A project with no grants is open to every member; otherwise a grant is required. */
export function canRequest(member: GuildMember, project: VikunjaProjectMap): boolean {
  if (isWardenAdmin(member)) return true;
  const grants = listProjectGrants(project.id);
  return grants.length === 0 || grants.some((g) => matchesSubject(member, g));
}

export function projectsFor(member: GuildMember): VikunjaProjectMap[] {
  return listProjectMaps().filter((p) => p.enabled && canRequest(member, p));
}
