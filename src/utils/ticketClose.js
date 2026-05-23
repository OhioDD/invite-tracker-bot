import { closeTicketRecord } from '../database/db.js';
import { removeCachedTicket } from './ticketCache.js';

const deletionLocks = new Set();

/** Closes a ticket channel with a deletion lock to prevent double-deletion. */
export async function closeTicketChannel(channel, reason = 'Ticket closed') {
  if (!channel?.id) return;
  if (deletionLocks.has(channel.id)) return;

  await closeTicketRecord(channel.id);
  removeCachedTicket(channel.id);

  deletionLocks.add(channel.id);

  setTimeout(async () => {
    try {
      if (channel.deletable) {
        await channel.delete(reason);
      }
    } catch (err) {
      if (err.code !== 10003) {
        console.error('Error deleting ticket channel:', err);
      }
    } finally {
      deletionLocks.delete(channel.id);
    }
  }, 2500);
}
