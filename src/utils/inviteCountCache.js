import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import sql from '../database/db.js';
import config from '../config.js';

const CACHE_DIR = join(process.cwd(), 'data');
const CACHE_FILE = join(CACHE_DIR, 'invite-counts.json');

/** @type {Map<string, number>} */
const counts = new Map();
let dirty = false;
let refreshInFlight = null;
let refreshGeneration = 0;

async function persistToDisk() {
  if (!dirty) return;
  await mkdir(CACHE_DIR, { recursive: true });
  const payload = {
    guildId: config.mainGuildId,
    updatedAt: new Date().toISOString(),
    counts: Object.fromEntries(counts)
  };
  await writeFile(CACHE_FILE, JSON.stringify(payload));
  dirty = false;
}

export async function initInviteCountCache() {
  await mkdir(CACHE_DIR, { recursive: true });
  try {
    const raw = await readFile(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.guildId === config.mainGuildId && data.counts) {
      for (const [userId, count] of Object.entries(data.counts)) {
        counts.set(userId, Number(count) || 0);
      }
      console.log(`Loaded ${counts.size} cached invite counts from disk`);
    }
  } catch {
    // no cache file yet
  }

  await refreshInviteCountCacheFromDb();
  setInterval(() => persistToDisk().catch(console.error), 60_000);
  setInterval(() => refreshInviteCountCacheFromDb().catch(console.error), 120_000);
}

export async function refreshInviteCountCacheFromDb() {
  if (refreshInFlight) return refreshInFlight;

  const gen = ++refreshGeneration;

  refreshInFlight = (async () => {
    const rows = await sql`
      SELECT inviter_id, COUNT(*)::int AS count
      FROM invites
      WHERE guild_id = ${config.mainGuildId}
        AND invitee_id <> inviter_id
        AND is_fake = FALSE
        AND is_left = FALSE
        AND is_vanity = FALSE
      GROUP BY inviter_id
    `;

    counts.clear();
    for (const row of rows) {
      counts.set(row.inviter_id, Number(row.count) || 0);
    }
    dirty = true;
    console.log(`Invite count cache refreshed (${counts.size} inviters)`);
  })();

  try {
    await refreshInFlight;
  } finally {
    if (gen === refreshGeneration) {
      refreshInFlight = null;
    }
  }
}

let debounceTimer = null;

export function scheduleInviteCountRefresh() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    refreshInviteCountCacheFromDb().catch(console.error);
  }, 4000);
}

/** Fast path for tickets / buttons — no database round-trip. */
export function getCachedInviteCount(userId) {
  return counts.get(userId) ?? 0;
}

export function setCachedInviteCount(userId, count) {
  counts.set(userId, Math.max(0, count));
  dirty = true;
}
