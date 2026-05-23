import { onMemberLeave } from '../utils/inviteEngine.js';
import config from '../config.js';

export const name = 'guildMemberRemove';

/** Handles member leave events — marks invitees as left on main guild. */
export async function execute(member) {
  try {
    if (member.guild.id !== config.mainGuildId) return;
    await onMemberLeave(member.guild, member);
  } catch (error) {
    console.error('Error in guildMemberRemove event:', error);
  }
}
