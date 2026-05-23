/**
 * Invite tracking — production-grade for 100k+ servers
 *
 * ONLINE: Exact attribution via Discord's guildMemberAdd.invite property.
 * OFFLINE: Snapshot-based delta recovery — best possible within Discord API limits.
 * SCALE: Batch DB ops, chunked processing, O(1) lookups.
 */

import {
  recordInvite,
  batchRecordInvites,
  hasInviteRecord,
  getTrackedInviteeIdsSet,
  getActiveInviteeIds,
  markUserLeftSync,
  batchMarkUsersLeft,
  registerInviteCode,
  unregisterInviteCode,
  getInviterForCode,
  snapshotInviteUses,
  getLatestInviteSnapshot
} from '../database/db.js';
import { isFakeAccount } from './inviteTracker.js';
import { scheduleInviteCountRefresh, refreshInviteCountCacheFromDb } from './inviteCountCache.js';
import config from '../config.js';
import { withGuildLock } from './guildState.js';

const CHUNK_SIZE = 500;
const API_DELAY_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUnknownMemberError(err) {
  if (!err) return false;
  const { code } = err;
  return (
    code === 'UnknownMember' ||
    code === 10007 ||
    code === '10007' ||
    err.message?.includes('Unknown Member')
  );
}

/* ─────────────────────────── ONLINE (EXACT) ─────────────────────────── */

/**
 * Live member join — Discord tells us exactly which invite was used.
 */
export async function onMemberJoin(guild, member, invite = null) {
  return withGuildLock(guild.id, async () => {
    if (member.user.bot) return { ok: false, reason: 'bot' };

    if (await hasInviteRecord(member.id, guild.id)) {
      console.log(`Rejoin ignored: ${member.user.tag}`);
      return { ok: false, reason: 'rejoin' };
    }

    let inviterId = null;
    let inviteCode = null;
    let isVanity = false;

    if (invite) {
      inviterId = invite.inviter?.id ?? null;
      inviteCode = invite.code ?? null;

      if (inviterId) {
        await registerInviteCode(guild.id, inviteCode, inviterId);
      }
    }

    if (!inviterId && inviteCode) {
      inviterId = await getInviterForCode(guild.id, inviteCode);
    }

    if (!inviterId && !inviteCode && guild.vanityURLCode) {
      try {
        const vanityData = await guild.fetchVanityData();
        if (vanityData?.code) {
          inviteCode = vanityData.code;
          isVanity = true;
          inviterId = 'vanity';
        }
      } catch {
        // vanity fetch failed, continue without
      }
    }

    if (!inviterId) {
      console.warn(`Join ${member.user.tag}: no inviter found — not counted`);
      return { ok: false, reason: 'no_inviter' };
    }

    const fake = isFakeAccount(member);
    const inserted = await recordInvite(inviterId, member.id, guild.id, fake, inviteCode, isVanity);

    if (inserted) {
      const label = isVanity ? 'vanity' : inviterId;
      const tags = [];
      if (fake) tags.push('fake');
      if (isVanity) tags.push('analytics-only');
      const tagSuffix = tags.length ? ' [' + tags.join(', ') + ']' : '';
      console.log(`[live] ${member.user.tag} → ${label} (${inviteCode ?? '?'})${tagSuffix}`);
      scheduleInviteCountRefresh();
      return { ok: true, source: 'live', inviterId, fake, isVanity };
    }

    return { ok: false, reason: 'already_recorded' };
  });
}

export async function onInviteCreate(guild, invite) {
  if (!invite.code || !invite.inviter?.id) return;
  await registerInviteCode(guild.id, invite.code, invite.inviter.id);
}

export async function onInviteDelete(guild, invite) {
  if (!invite.code) return;
  await unregisterInviteCode(guild.id, invite.code);
}

export async function onMemberLeave(guild, member) {
  const updated = await markUserLeftSync(member.id, guild.id);
  if (updated) {
    scheduleInviteCountRefresh();
  }
  return updated;
}

/* ─────────────────────── OFFLINE RECOVERY ─────────────────────── */

/**
 * Build invite use deltas: compare current invites to last snapshot.
 * Returns array of { code, inviterId, isVanity, delta } for codes with increased uses.
 */
async function computeInviteDeltas(guild, currentInvites, vanityData = null) {
  const snapshotMap = await getLatestInviteSnapshot(guild.id);

  const deltas = [];

  for (const [code, inv] of currentInvites) {
    if (!inv.inviter) continue;
    const prev = snapshotMap.get(code)?.uses ?? 0;
    const delta = inv.uses - prev;
    if (delta > 0) {
      deltas.push({
        code,
        inviterId: inv.inviter.id,
        delta,
        isVanity: false
      });
    }
  }

  if (vanityData?.code) {
    const prev = snapshotMap.get(vanityData.code)?.uses ?? 0;
    const delta = vanityData.uses - prev;
    if (delta > 0) {
      console.log(`Vanity URL uses increased by ${delta} — not attributed to any inviter`);
    }
  }

  return deltas;
}

/**
 * Expand deltas into individual invite slots, ordered by code.
 * Each delta of N becomes N slots for that code.
 */
function expandSlots(deltas) {
  const slots = [];
  for (const d of deltas) {
    for (let i = 0; i < d.delta; i += 1) {
      slots.push({ code: d.code, inviterId: d.inviterId, isVanity: d.isVanity });
    }
  }
  return slots;
}

/**
 * Fetch vanity URL data (separate API call, not in guild.invites.fetch()).
 */
async function fetchVanityData(guild) {
  if (!guild.vanityURLCode) return null;
  try {
    const data = await guild.fetchVanityData();
    return { code: data.code, uses: data.uses };
  } catch {
    return null;
  }
}

const FETCH_RETRIES = 3;
const FETCH_CHUNK_SIZE = 5000;

/** Fetches all guild members in paginated chunks with retries. */
async function fetchAllMembersChunked(guild) {
  const fetched = [];
  let after;

  while (true) {
    let chunk;
    let ok = false;

    for (let retry = 1; retry <= FETCH_RETRIES; retry += 1) {
      try {
        chunk = await guild.members.fetch({ limit: FETCH_CHUNK_SIZE, after });
        ok = true;
        if (retry > 1) console.log(`Members fetch succeeded on attempt ${retry}`);
        break;
      } catch (err) {
        if (retry < FETCH_RETRIES) {
          const wait = retry * 2000;
          console.warn(`Members fetch attempt ${retry} failed (${err.message}), retrying in ${wait}ms...`);
          await sleep(wait);
        } else {
          console.error(`Members fetch failed after ${FETCH_RETRIES} attempts: ${err.message}`);
        }
      }
    }

    if (!ok || chunk.size === 0) break;

    fetched.push(...chunk.values());
    after = chunk.last()?.id;
  }

  return fetched;
}

/**
 * Offline sync — snapshot-based recovery for when bot was down.
 *
 * Steps:
 * 1. Fetch current invites + vanity data
 * 2. Compare to last snapshot → compute deltas
 * 3. Find untracked members (single DB query → Set)
 * 4. Sort by join timestamp, match to slots FIFO
 * 5. Batch insert all matched invites
 * 6. Mark absent tracked members as left
 * 7. Take new snapshot
 */
export async function syncInviteLedger(guild) {
  if (guild.id !== config.mainGuildId) {
    return { left: 0, valid: 0, fake: 0, synced: 0 };
  }

  return withGuildLock(guild.id, async () => {
    const stats = { left: 0, valid: 0, fake: 0, synced: 0 };

    /* ── Step 1: Fetch current invites ── */
    let currentInvites;
    try {
      currentInvites = await guild.invites.fetch();
    } catch (err) {
      console.error('Failed to fetch invites for sync:', err.message);
      return stats;
    }

    const vanityData = await fetchVanityData(guild);

    /* ── Step 2: Compute deltas ── */
    const deltas = await computeInviteDeltas(guild, currentInvites, vanityData);
    const totalDelta = deltas.reduce((sum, d) => sum + d.delta, 0);

    if (totalDelta === 0) {
      /* No new invites since last snapshot — just check for leaves */
      stats.left = await markAbsentAsLeft(guild);
      await snapshotInviteUses(guild.id, currentInvites, vanityData);
      return stats;
    }

    console.log(`Offline recovery: ${totalDelta} invite use(s) unaccounted for across ${deltas.length} code(s)`);

    /* ── Step 3: Get tracked invitee IDs (single query → Set) ── */
    const trackedSet = await getTrackedInviteeIdsSet(guild.id);

    /* ── Step 4: Fetch members if cache is empty (large servers) ── */
    let membersToScan;
    if (guild.members.cache.size < 100) {
      console.log(`Member cache empty (${guild.members.cache.size}), fetching members in chunks...`);
      membersToScan = await fetchAllMembersChunked(guild);
      if (membersToScan.length === 0) {
        console.error('CRITICAL: Failed to fetch any members — offline recovery will be incomplete');
      }
    }

    /* ── Step 5: Find untracked members, sorted by join time ── */
    membersToScan = membersToScan ?? guild.members.cache;
    const untracked = [];
    let processed = 0;

    for (const member of membersToScan.values()) {
      if (member.user.bot) continue;
      if (trackedSet.has(member.id)) continue;
      untracked.push(member);
      processed += 1;

      if (processed % CHUNK_SIZE === 0) {
        await sleep(0);
      }
    }

    untracked.sort((a, b) => a.joinedTimestamp - b.joinedTimestamp);

    if (untracked.length === 0) {
      console.log(`Offline recovery: ${totalDelta} delta(s) but no untracked members in cache`);
      await snapshotInviteUses(guild.id, currentInvites, vanityData);
      return stats;
    }

    console.log(`Offline recovery: ${untracked.length} untracked member(s), ${totalDelta} invite slot(s)`);

    /* ── Step 6: Match members to slots FIFO ── */
    const slots = expandSlots(deltas);
    const entries = [];
    let slotIdx = 0;

    for (const member of untracked) {
      if (slotIdx >= slots.length) break;

      const slot = slots[slotIdx];

      if (slot.inviterId === member.id) continue;

      const fake = isFakeAccount(member);
      entries.push({
        inviterId: slot.inviterId,
        inviteeId: member.id,
        guildId: guild.id,
        inviteCode: slot.code,
        isFake: fake,
        isVanity: slot.isVanity ?? false
      });

      if (fake) stats.fake += 1;
      else stats.valid += 1;

      slotIdx += 1;
    }

    /* ── Step 7: Batch insert ── */
    if (entries.length > 0) {
      const inserted = await batchRecordInvites(entries);
      stats.synced = inserted;
      console.log(
        `Offline recovery: inserted ${inserted}/${entries.length} invites (${stats.valid} valid, ${stats.fake} fake)`
      );
    }

    /* ── Step 8: Mark absent members as left ── */
    stats.left = await markAbsentAsLeft(guild);

    /* ── Step 9: Take new snapshot ── */
    await snapshotInviteUses(guild.id, currentInvites, vanityData);

    /* ── Step 10: Refresh cache ── */
    await refreshInviteCountCacheFromDb();

    if (stats.synced > 0 || stats.left > 0) {
      console.log(
        `Invite sync complete: ${stats.synced} synced, ${stats.left} left`
      );
    }

    return stats;
  });
}

/**
 * Mark members who are in DB as active but not in guild → left.
 * Uses batch update for performance.
 */
async function markAbsentAsLeft(guild) {
  const activeIds = await getActiveInviteeIds(guild.id);
  if (activeIds.length === 0) return 0;

  const absentIds = [];

  for (const inviteeId of activeIds) {
    if (guild.members.cache.has(inviteeId)) continue;

    try {
      await guild.members.fetch(inviteeId);
    } catch (err) {
      if (isUnknownMemberError(err)) {
        absentIds.push(inviteeId);
      }
    }

    if (absentIds.length % CHUNK_SIZE === 0 && absentIds.length > 0) {
      await sleep(API_DELAY_MS);
    }
  }

  if (absentIds.length === 0) return 0;

  const marked = await batchMarkUsersLeft(absentIds, guild.id);
  if (marked > 0) {
    console.log(`Marked ${marked} member(s) as left (absent from guild)`);
    scheduleInviteCountRefresh();
  }

  return marked;
}

/* ─────────────────────── STARTUP / SHUTDOWN ─────────────────────── */

/**
 * Rebuild invite registry from live invites (startup recovery).
 */
export async function rebuildInviteRegistry(guild) {
  return withGuildLock(guild.id, async () => {
    let registered = 0;

    try {
      const invites = await guild.invites.fetch();
      const entries = [...invites.values()].filter((inv) => inv.inviter && inv.code);
      await Promise.all(
        entries.map((inv) => registerInviteCode(guild.id, inv.code, inv.inviter.id))
      );
      registered = entries.length;
    } catch (err) {
      console.error('Failed to rebuild invite registry:', err.message);
    }

    try {
      await fetchVanityData(guild);
    } catch {
      // vanity not available
    }

    console.log(`Rebuilt invite registry: ${registered} code(s) registered`);
    return { registered };
  });
}

/**
 * Take a full snapshot of current invite uses. Called on shutdown.
 */
export async function takeInviteSnapshot(guild) {
  if (guild.id !== config.mainGuildId) return 0;

  try {
    const invites = await guild.invites.fetch();
    const vanityData = await fetchVanityData(guild);
    const count = await snapshotInviteUses(guild.id, invites, vanityData);
    console.log(`Invite snapshot taken: ${count} invite(s) recorded`);
    return count;
  } catch (err) {
    console.error('Failed to take invite snapshot:', err.message);
    return 0;
  }
}
