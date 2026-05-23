import { rebuildInviteRegistry, syncInviteLedger, takeInviteSnapshot } from '../utils/inviteEngine.js';
import { completeRecovery } from '../utils/guildState.js';
import { reconcileAllTicketsInGuild } from '../utils/ticketReconcile.js';
import config from '../config.js';

export const name = 'clientReady';
export const once = true;

export async function execute(client) {
  try {
    console.log(`Logged in as ${client.user.tag}`);

    const mainGuild = client.guilds.cache.get(config.mainGuildId);
    const claimGuild = client.guilds.cache.get(config.claimGuildId);

    if (mainGuild) {
      try {
        console.log('Rebuilding invite registry from live invites...');
        await rebuildInviteRegistry(mainGuild);

        console.log('Running offline invite recovery...');
        await syncInviteLedger(mainGuild);
      } catch (error) {
        console.error('Invite recovery error:', error);
      }
    } else {
      console.error('Main guild not found');
    }

    completeRecovery();

    if (claimGuild) {
      await reconcileAllTicketsInGuild(claimGuild);
    } else {
      console.error('Claim guild not found');
    }

    console.log('Bot ready');
  } catch (error) {
    completeRecovery();
    console.error('Ready event error:', error);
  }
}
