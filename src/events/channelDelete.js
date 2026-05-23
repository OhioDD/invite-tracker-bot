import { ChannelType } from 'discord.js';
import { closeTicketRecord } from '../database/db.js';
import { removeCachedTicket } from '../utils/ticketCache.js';
import config from '../config.js';

export const name = 'channelDelete';

/** Handles channel deletion — auto-closes ticket records for deleted channels. */
export async function execute(channel) {
  try {
    if (!channel.guild || channel.guild.id !== config.claimGuildId) return;
    if (channel.type !== ChannelType.GuildText) return;

    const closed = await closeTicketRecord(channel.id);
    if (closed) {
      removeCachedTicket(channel.id);
      console.log(`Auto-closed ticket for deleted channel ${channel.id}`);
    }
  } catch (error) {
    console.error('channelDelete event error:', error);
  }
}
