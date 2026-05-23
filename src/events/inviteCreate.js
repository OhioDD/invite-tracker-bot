import { onInviteCreate } from '../utils/inviteEngine.js';
import config from '../config.js';

export const name = 'inviteCreate';

export async function execute(invite) {
  try {
    if (invite.guild.id !== config.mainGuildId) return;
    await onInviteCreate(invite.guild, invite);
  } catch (error) {
    console.error('Error in inviteCreate event:', error);
  }
}
