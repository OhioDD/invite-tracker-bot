/** In-memory ticket rows by channel — avoids DB on every button click. */

/** @type {Map<string, object>} */
const byChannel = new Map();

export function cacheTicket(ticket) {
  if (ticket?.channel_id) {
    byChannel.set(ticket.channel_id, { ...ticket });
  }
}

export function getCachedTicket(channelId) {
  return byChannel.get(channelId) ?? null;
}

export function patchCachedTicket(channelId, fields) {
  const ticket = byChannel.get(channelId);
  if (ticket) {
    Object.assign(ticket, fields);
  }
}

export function removeCachedTicket(channelId) {
  byChannel.delete(channelId);
}
