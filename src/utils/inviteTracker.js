import config from '../config.js';
import { waitForRecovery } from './guildState.js';
import { onMemberJoin } from './inviteEngine.js';

/** Checks if a member looks like a fake/alt account based on account age. */
export function isFakeAccount(member) {
  if (member.user.bot) return true;
  const daysOld = (Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
  return daysOld < config.fakeInviteThresholdDays;
}

export async function handleMemberJoin(member, invite = null) {
  try {
    if (member.user.bot) return;
    await waitForRecovery();
    await onMemberJoin(member.guild, member, invite);
  } catch (err) {
    console.error('Error handling member join:', err);
  }
}
