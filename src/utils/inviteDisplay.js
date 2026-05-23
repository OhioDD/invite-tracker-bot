import { getValidInviteeIds } from '../database/db.js';

/** Resolve Discord usernames for counted invitees (main server). */
export async function formatCountedInvitees(client, guildId, inviterId) {
  const ids = await getValidInviteeIds(inviterId, guildId);
  if (ids.length === 0) return null;

  const guild = await client.guilds.fetch(guildId);
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      try {
        const member = await guild.members.fetch(id);
        return `@${member.user.username}`;
      } catch {
        try {
          const user = await client.users.fetch(id);
          return `@${user.username}`;
        } catch {
          return `<@${id}>`;
        }
      }
    })
  );

  return results.map((r) => (r.status === 'fulfilled' ? r.value : `<@${ids[results.indexOf(r)]}>`)).join(', ');
}
