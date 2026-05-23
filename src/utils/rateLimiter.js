const cooldowns = new Map();

const DEFAULTS = {
  invite: 3000,
  claim: 10000,
  staff: 2000,
  ticket: 2000,
  invites: 2000,
  help: 1000
};

function getCooldown(commandName) {
  return DEFAULTS[commandName] ?? 2000;
}

export function checkRateLimit(userId, commandName) {
  const key = `${userId}:${commandName}`;
  const now = Date.now();
  const last = cooldowns.get(key);
  const ms = getCooldown(commandName);

  if (last && now - last < ms) {
    const remaining = ((last + ms - now) / 1000).toFixed(1);
    return remaining;
  }

  cooldowns.set(key, now);
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of cooldowns) {
    const [, name] = key.split(':');
    const ms = DEFAULTS[name] ?? 2000;
    if (now - ts > ms * 2) cooldowns.delete(key);
  }
}, 60_000);
