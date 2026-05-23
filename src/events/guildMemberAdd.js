import { handleMemberJoin } from '../utils/inviteTracker.js';
import config from '../config.js';

export const name = 'guildMemberAdd';

/** Handles member join events — records invite attribution on main guild. */
export async function execute(member) {
  try {
    if (member.guild.id !== config.mainGuildId) return;
    await handleMemberJoin(member, member.invite ?? null);
  } catch (error) {
    console.error('Error in guildMemberAdd event:', error);
  }
}
