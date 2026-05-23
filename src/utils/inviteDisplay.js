import { getValidInviteeIds } from '../database/db.js';

/** Resolve Discord usernames for counted invitees (main server). */
export async function formatCountedInvitees(client, guildId, inviterId) {
  const ids = await getValidInviteeIds(inviterId, guildId);
  if (ids.length === 0) return null;

  const guild = await client.guilds.fetch(guildId);
  const names = [];

  for (const id of ids) {
    try {
      const member = await guild.members.fetch(id);
      names.push(`@${member.user.username}`);
    } catch {
      try {
        const user = await client.users.fetch(id);
        names.push(`@${user.username}`);
      } catch {
        names.push(`<@${id}>`);
      }
    }
  }

  return names.join(', ');
}
