import {
  getActiveTicketByUser,
  closeTicketRecord,
  closeTicketById,
  getAllActiveTicketsForGuild
} from '../database/db.js';
import { removeCachedTicket } from './ticketCache.js';

function isPendingPlaceholder(channelId) {
  return typeof channelId === 'string' && channelId.startsWith('pending:');
}

async function fetchChannel(guild, channelId) {
  const cached = guild.channels.cache.get(channelId);
  if (cached) return cached;
  try {
    return await guild.channels.fetch(channelId);
  } catch {
    return null;
  }
}

/**
 * Close DB ticket if channel was deleted or reservation was never finished.
 */
export async function closeOrphanTicket(ticket, reason) {
  if (isPendingPlaceholder(ticket.channel_id)) {
    await closeTicketById(ticket.id);
  } else {
    await closeTicketRecord(ticket.channel_id);
  }
  removeCachedTicket(ticket.channel_id);
  console.log(`Closed orphan ticket #${ticket.id} (${reason}) for user ${ticket.user_id}`);
}

/**
 * Returns { ticket, channel } if user has a real open ticket, else null after cleanup.
 */
export async function reconcileTicketsForUser(guild, userId) {
  const ticket = await getActiveTicketByUser(userId, guild.id);
  if (!ticket) return null;

  if (isPendingPlaceholder(ticket.channel_id)) {
    await closeOrphanTicket(ticket, 'stuck reservation');
    return null;
  }

  const channel = await fetchChannel(guild, ticket.channel_id);
  if (!channel) {
    await closeOrphanTicket(ticket, 'channel deleted');
    return null;
  }

  return { ticket, channel };
}

/** Sweep all active tickets for a guild (run on startup). */
export async function reconcileAllTicketsInGuild(guild) {
  const tickets = await getAllActiveTicketsForGuild(guild.id);
  let closed = 0;

  const results = await Promise.allSettled(
    tickets.map(async (ticket) => {
      if (isPendingPlaceholder(ticket.channel_id)) {
        await closeOrphanTicket(ticket, 'stuck reservation (startup)');
        return 1;
      }

      const channel = await fetchChannel(guild, ticket.channel_id);
      if (!channel) {
        await closeOrphanTicket(ticket, 'channel missing (startup)');
        return 1;
      }

      return 0;
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) closed += 1;
  }

  if (closed > 0) {
    console.log(`Ticket reconcile: closed ${closed} orphan ticket(s) in ${guild.name}`);
  }
}
