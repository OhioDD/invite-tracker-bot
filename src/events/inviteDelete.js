import { onInviteDelete } from '../utils/inviteEngine.js';
import config from '../config.js';

export const name = 'inviteDelete';

export async function execute(invite) {
  try {
    if (invite.guild.id !== config.mainGuildId) return;
    await onInviteDelete(invite.guild, invite);
  } catch (error) {
    console.error('Error in inviteDelete event:', error);
  }
}
