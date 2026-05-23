function slugify(text, maxLen = 24) {
  return (
    String(text)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, maxLen) || 'user'
  );
}

/** Open ticket: claim-{username}-{last4id} */
export function buildTicketChannelName(username, userId) {
  const suffix = userId.slice(-4);
  return `claim-${slugify(username, 24)}-${suffix}`.slice(0, 100);
}

/** After proof + claim name: verified-{username}-{claim} */
export function buildVerifiedChannelName(username, claimName) {
  return `verified-${slugify(username, 20)}-${slugify(claimName, 32)}`.slice(0, 100);
}