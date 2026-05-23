import { neon } from '@neondatabase/serverless';
import config from '../config.js';
import { withRetry } from '../utils/retry.js';

const sql = neon(config.databaseUrl);

/** Parses count from a query result row. */
function parseCount(result) {
  const row = result?.[0];
  const count = row?.count ?? 0;
  return Number.parseInt(String(count), 10) || 0;
}

/** Initializes database schema and tables, runs migrations. */
export async function initDatabase() {
  await sql`
    CREATE TABLE IF NOT EXISTS invites (
      id SERIAL PRIMARY KEY,
      inviter_id VARCHAR(20) NOT NULL,
      invitee_id VARCHAR(20) NOT NULL,
      guild_id VARCHAR(20) NOT NULL,
      invite_code VARCHAR(50),
      joined_at TIMESTAMP DEFAULT NOW(),
      left_at TIMESTAMP,
      is_fake BOOLEAN DEFAULT FALSE,
      is_left BOOLEAN DEFAULT FALSE,
      is_vanity BOOLEAN DEFAULT FALSE
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_invites_inviter ON invites(inviter_id, guild_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_invites_invitee ON invites(invitee_id, guild_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_invites_composite ON invites(inviter_id, guild_id, is_fake, is_left)`;

  await sql`
    DO $$ BEGIN
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS is_vanity BOOLEAN DEFAULT FALSE;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `;

  await sql`
    DELETE FROM invites a
    USING invites b
    WHERE a.id > b.id
      AND a.guild_id = b.guild_id
      AND a.invitee_id = b.invitee_id
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_guild_invitee
    ON invites(guild_id, invitee_id)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS invite_registry (
      guild_id VARCHAR(20) NOT NULL,
      code VARCHAR(50) NOT NULL,
      inviter_id VARCHAR(20) NOT NULL,
      is_vanity BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (guild_id, code)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_registry_inviter ON invite_registry(guild_id, inviter_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS invite_use_snapshots (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(20) NOT NULL,
      code VARCHAR(50) NOT NULL,
      inviter_id VARCHAR(20),
      uses INTEGER NOT NULL,
      is_vanity BOOLEAN DEFAULT FALSE,
      taken_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_snapshots_guild_time ON invite_use_snapshots(guild_id, taken_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_snapshots_guild_code ON invite_use_snapshots(guild_id, code)`;

  await sql`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      channel_id VARCHAR(64) NOT NULL UNIQUE,
      user_id VARCHAR(20) NOT NULL,
      guild_id VARCHAR(20) NOT NULL,
      status VARCHAR(20) DEFAULT 'open',
      claimed_count INTEGER,
      actual_count INTEGER,
      verification_note TEXT,
      proof_anchor_message_id VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW(),
      closed_at TIMESTAMP
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, guild_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets(channel_id)`;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_one_active_per_user
    ON tickets(user_id, guild_id)
    WHERE status NOT IN ('closed', 'rejected')
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id VARCHAR(20) NOT NULL,
      config_key VARCHAR(50) NOT NULL,
      config_value TEXT,
      PRIMARY KEY (guild_id, config_key)
    )
  `;

  const purged = await purgeSelfInviteRows(config.mainGuildId);
  if (purged > 0) {
    console.log(`Purged ${purged} self-invite row(s) from database`);
  }

  const purgedVanity = await purgeVanityRows(config.mainGuildId);
  if (purgedVanity > 0) {
    console.log(`Purged ${purgedVanity} vanity invite row(s) from database`);
  }
}

/** Gets valid (non-fake, non-left, non-self) invitee IDs for an inviter. */
export async function getValidInviteeIds(inviterId, guildId) {
  const rows = await sql`
    SELECT invitee_id
    FROM invites
    WHERE inviter_id = ${inviterId}
      AND invitee_id <> ${inviterId}
      AND guild_id = ${guildId}
      AND is_fake = FALSE
      AND is_left = FALSE
      AND is_vanity = FALSE
    ORDER BY joined_at ASC
  `;
  return rows.map((r) => r.invitee_id);
}

/** Gets valid invite count for a user, updating cache for main guild. */
export async function getValidInviteCount(userId, guildId) {
  const result = await sql`
    SELECT COUNT(*)::int AS count
    FROM invites
    WHERE inviter_id = ${userId}
      AND invitee_id <> ${userId}
      AND guild_id = ${guildId}
      AND is_fake = FALSE
      AND is_left = FALSE
      AND is_vanity = FALSE
  `;
  const count = parseCount(result);

  if (guildId === config.mainGuildId) {
    const { setCachedInviteCount } = await import('../utils/inviteCountCache.js');
    setCachedInviteCount(userId, count);
  }

  return count;
}

/** Clears all invite records for a user in a guild. */
export async function clearUserInvites(userId, guildId) {
  const result = await sql`
    DELETE FROM invites
    WHERE inviter_id = ${userId} AND guild_id = ${guildId}
    RETURNING id
  `;

  if (guildId === config.mainGuildId) {
    const { setCachedInviteCount, scheduleInviteCountRefresh } = await import(
      '../utils/inviteCountCache.js'
    );
    setCachedInviteCount(userId, 0);
    scheduleInviteCountRefresh();
  }

  return result.length > 0;
}

/** Records a single invite, avoiding duplicates via ON CONFLICT. */
export async function recordInvite(inviterId, inviteeId, guildId, isFake, inviteCode = null, isVanity = false) {
  if (inviterId === inviteeId) return false;

  const result = await withRetry(() => sql`
    INSERT INTO invites (
      inviter_id, invitee_id, guild_id, invite_code, is_fake, is_left, is_vanity
    )
    VALUES (
      ${inviterId}, ${inviteeId}, ${guildId}, ${inviteCode}, ${isFake}, FALSE, ${isVanity}
    )
    ON CONFLICT (guild_id, invitee_id) DO NOTHING
    RETURNING id
  `, 'recordInvite');

  if (result.length > 0 && inviteCode) {
    await sql`
      INSERT INTO invite_registry (guild_id, code, inviter_id, updated_at)
      VALUES (${guildId}, ${inviteCode}, ${inviterId}, NOW())
      ON CONFLICT (guild_id, code)
      DO UPDATE SET inviter_id = ${inviterId}, updated_at = NOW()
    `;
  }

  return result.length > 0;
}

/**
 * Batch insert multiple invites in a single multi-row INSERT.
 * Returns count of newly inserted rows.
 */
export async function batchRecordInvites(entries) {
  if (entries.length === 0) return 0;

  const filtered = entries.filter((e) => e.inviterId !== e.inviteeId);
  if (filtered.length === 0) return 0;

  const result = await withRetry(() => sql`
    INSERT INTO invites (inviter_id, invitee_id, guild_id, invite_code, is_fake, is_left, is_vanity)
    SELECT * FROM UNNEST(
      ${filtered.map((e) => e.inviterId)}::VARCHAR[],
      ${filtered.map((e) => e.inviteeId)}::VARCHAR[],
      ${filtered.map((e) => e.guildId)}::VARCHAR[],
      ${filtered.map((e) => e.inviteCode ?? null)}::VARCHAR[],
      ${filtered.map((e) => e.isFake)}::BOOLEAN[],
      ${filtered.map(() => false)}::BOOLEAN[],
      ${filtered.map((e) => e.isVanity ?? false)}::BOOLEAN[]
    )
    ON CONFLICT (guild_id, invitee_id) DO NOTHING
    RETURNING id
  `, 'batchRecordInvites');

  const inserted = result.length;

  if (inserted > 0) {
    const codeMap = new Map();
    for (const e of filtered) {
      if (e.inviteCode) codeMap.set(e.inviteCode, e);
    }
    if (codeMap.size > 0) {
      await sql`
        INSERT INTO invite_registry (guild_id, code, inviter_id, updated_at)
        SELECT * FROM UNNEST(
          ${[...codeMap.values()].map((e) => e.guildId)}::VARCHAR[],
          ${[...codeMap.keys()]}::VARCHAR[],
          ${[...codeMap.values()].map((e) => e.inviterId)}::VARCHAR[],
          ARRAY(SELECT NOW() FROM generate_series(1, ${codeMap.size}))::TIMESTAMP[]
        )
        ON CONFLICT (guild_id, code)
        DO UPDATE SET inviter_id = EXCLUDED.inviter_id, updated_at = NOW()
      `;
    }
  }

  return inserted;
}

/** Gets all invite history for an inviter in a guild. */
export async function getInviteHistoryForInviter(inviterId, guildId) {
  return await sql`
    SELECT invitee_id, invite_code, is_fake, is_left, joined_at, left_at
    FROM invites
    WHERE inviter_id = ${inviterId} AND guild_id = ${guildId}
    ORDER BY joined_at ASC
  `;
}

async function purgeSelfInviteRows(guildId) {
  const removed = await sql`
    DELETE FROM invites
    WHERE guild_id = ${guildId}
      AND invitee_id = inviter_id
    RETURNING id
  `;
  return removed.length;
}

async function purgeVanityRows(guildId) {
  const removed = await sql`
    DELETE FROM invites
    WHERE guild_id = ${guildId}
      AND inviter_id = 'vanity'
    RETURNING id
  `;
  return removed.length;
}

/** Checks if an invite record exists for a user in a guild. */
export async function hasInviteRecord(userId, guildId) {
  const result = await sql`
    SELECT COUNT(*)::int AS count
    FROM invites
    WHERE invitee_id = ${userId} AND guild_id = ${guildId}
  `;
  return parseCount(result) > 0;
}

/**
 * Get ALL tracked invitee IDs for a guild in a single query.
 * Returns a Set for O(1) lookups — critical for 100k+ servers.
 */
export async function getTrackedInviteeIdsSet(guildId) {
  const rows = await sql`
    SELECT invitee_id FROM invites WHERE guild_id = ${guildId}
  `;
  return new Set(rows.map((r) => r.invitee_id));
}

/** Gets active invitee IDs that are not marked as left. */
export async function getActiveInviteeIds(guildId) {
  const rows = await sql`
    SELECT invitee_id
    FROM invites
    WHERE guild_id = ${guildId}
      AND is_left = FALSE
      AND invitee_id <> inviter_id
      AND is_vanity = FALSE
  `;
  return rows.map((r) => r.invitee_id);
}

/** Marks a user as left in the invites table. */
export async function markUserLeftSync(userId, guildId) {
  const result = await sql`
    UPDATE invites
    SET is_left = TRUE, left_at = NOW()
    WHERE invitee_id = ${userId}
      AND guild_id = ${guildId}
      AND is_left = FALSE
    RETURNING id
  `;
  return result.length > 0;
}

/** Register an invite code → inviter mapping. */
export async function registerInviteCode(guildId, code, inviterId, isVanity = false) {
  if (!code || !inviterId) return;
  await sql`
    INSERT INTO invite_registry (guild_id, code, inviter_id, is_vanity, updated_at)
    VALUES (${guildId}, ${code}, ${inviterId}, ${isVanity}, NOW())
    ON CONFLICT (guild_id, code)
    DO UPDATE SET inviter_id = ${inviterId}, is_vanity = ${isVanity}, updated_at = NOW()
  `;
}

/** Unregisters an invite code from the registry. */
export async function unregisterInviteCode(guildId, code) {
  if (!code) return;
  await sql`DELETE FROM invite_registry WHERE guild_id = ${guildId} AND code = ${code}`;
}

/** Gets the inviter ID for an invite code. */
export async function getInviterForCode(guildId, code) {
  const result = await sql`
    SELECT inviter_id FROM invite_registry
    WHERE guild_id = ${guildId} AND code = ${code}
  `;
  return result.length > 0 ? result[0].inviter_id : null;
}

const STALE_DAYS = 30;

/** Cleans up invite registry entries older than 30 days. */
export async function cleanupStaleRegistry() {
  const removed = await sql`
    DELETE FROM invite_registry
    WHERE updated_at < NOW() - INTERVAL '30 days'
    RETURNING id
  `;
  if (removed.length > 0) {
    console.log(`Cleaned up ${removed.length} stale invite registry entries (>${STALE_DAYS} days)`);
  }
  return removed.length;
}

/**
 * Snapshot current invite uses. Called on shutdown and periodically.
 */
export async function snapshotInviteUses(guildId, invites, vanityData = null) {
  const rows = [];
  for (const inv of invites.values()) {
    if (!inv.inviter) continue;
    rows.push([guildId, inv.code, inv.inviter.id, inv.uses, false]);
  }

  if (vanityData?.code) {
    rows.push([guildId, vanityData.code, null, vanityData.uses, true]);
  }

  if (rows.length === 0) return 0;

  await withRetry(async () => {
    const gids = rows.map((r) => r[0]);
    const codes = rows.map((r) => r[1]);
    const invIds = rows.map((r) => r[2]);
    const uses = rows.map((r) => r[3]);
    const isVanities = rows.map((r) => r[4]);

    return await sql`
      INSERT INTO invite_use_snapshots (guild_id, code, inviter_id, uses, is_vanity, taken_at)
      SELECT * FROM UNNEST(
        ${gids}::VARCHAR[],
        ${codes}::VARCHAR[],
        ${invIds}::VARCHAR[],
        ${uses}::INT[],
        ${isVanities}::BOOLEAN[],
        ARRAY(SELECT NOW() FROM generate_series(1, ${rows.length}))::TIMESTAMP[]
      )
    `;
  }, 'snapshotInviteUses');

  return rows.length;
}

/**
 * Get the latest snapshot for a guild, grouped by code.
 * Returns Map<code, { uses, inviterId, isVanity }>.
 */
export async function getLatestInviteSnapshot(guildId) {
  const rows = await sql`
    SELECT DISTINCT ON (code) code, uses, inviter_id, is_vanity, taken_at
    FROM invite_use_snapshots
    WHERE guild_id = ${guildId}
    ORDER BY code, taken_at DESC
  `;

  const map = new Map();
  for (const row of rows) {
    map.set(row.code, {
      uses: Number(row.uses),
      inviterId: row.inviter_id,
      isVanity: Boolean(row.is_vanity)
    });
  }
  return map;
}

/**
 * Batch mark multiple users as left. Single query.
 */
export async function batchMarkUsersLeft(userIds, guildId) {
  if (userIds.length === 0) return 0;

  const result = await sql`
    UPDATE invites
    SET is_left = TRUE, left_at = NOW()
    WHERE invitee_id = ANY(${userIds})
      AND guild_id = ${guildId}
      AND is_left = FALSE
    RETURNING id
  `;

  return result.length;
}

/** Gets the active (non-closed) ticket for a user in a guild. */
export async function getActiveTicketByUser(userId, guildId) {
  const result = await sql`
    SELECT * FROM tickets
    WHERE user_id = ${userId}
      AND guild_id = ${guildId}
      AND status NOT IN ('closed', 'rejected')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return result.length > 0 ? result[0] : null;
}

/** Gets all active (non-closed) tickets for a guild. */
export async function getAllActiveTicketsForGuild(guildId) {
  return await sql`
    SELECT * FROM tickets
    WHERE guild_id = ${guildId}
      AND status NOT IN ('closed', 'rejected')
  `;
}

/** Inserts a new active ticket record, returns null on duplicate. */
export async function insertActiveTicket(channelId, userId, guildId, inviteCount) {
  const count = Number(inviteCount) || 0;
  const status = count > 0 ? 'awaiting_proof' : 'no_invites';

  try {
    const result = await sql`
      INSERT INTO tickets (channel_id, user_id, guild_id, status, claimed_count, actual_count)
      VALUES (${channelId}, ${userId}, ${guildId}, ${status}, ${count}, ${count})
      RETURNING *
    `;
    return result[0];
  } catch (err) {
    if (err.code === '23505') return null;
    throw err;
  }
}

/** Closes a ticket by its database ID, returns the channel ID. */
export async function closeTicketById(ticketId) {
  const result = await sql`
    UPDATE tickets
    SET status = 'closed', closed_at = NOW()
    WHERE id = ${ticketId}
      AND status NOT IN ('closed', 'rejected')
    RETURNING channel_id
  `;
  return result.length > 0 ? result[0].channel_id : null;
}

/** Gets a guild config value by key. */
export async function getGuildConfig(guildId, key) {
  const result = await sql`
    SELECT config_value FROM guild_config
    WHERE guild_id = ${guildId} AND config_key = ${key}
  `;
  return result.length > 0 ? result[0].config_value : null;
}

/** Sets a guild config value by key (upsert). */
export async function setGuildConfig(guildId, key, value) {
  await sql`
    INSERT INTO guild_config (guild_id, config_key, config_value)
    VALUES (${guildId}, ${key}, ${value})
    ON CONFLICT (guild_id, config_key)
    DO UPDATE SET config_value = ${value}
  `;
}

/** Gets the active ticket record by channel ID. */
export async function getTicketByChannel(channelId) {
  const result = await sql`
    SELECT * FROM tickets
    WHERE channel_id = ${channelId}
      AND status NOT IN ('closed', 'rejected')
  `;
  return result.length > 0 ? result[0] : null;
}

/** Updates ticket workflow status and related fields. */
export async function updateTicketWorkflow(channelId, fields) {
  const { status, claimedCount, actualCount, verificationNote } = fields;

  if (status === 'awaiting_proof') {
    await sql`
      UPDATE tickets
      SET status = ${status}, claimed_count = ${claimedCount}, actual_count = ${actualCount}
      WHERE channel_id = ${channelId} AND status NOT IN ('closed', 'rejected')
    `;
    return;
  }

  if (status === 'waiting_payout') {
    await sql`
      UPDATE tickets
      SET status = ${status}, verification_note = ${verificationNote ?? null}
      WHERE channel_id = ${channelId} AND status NOT IN ('closed', 'rejected')
    `;
    return;
  }

  if (status === 'verifying') {
    await sql`
      UPDATE tickets SET status = ${status}
      WHERE channel_id = ${channelId} AND status NOT IN ('closed', 'rejected')
    `;
    return;
  }

  if (status) {
    await sql`
      UPDATE tickets SET status = ${status}
      WHERE channel_id = ${channelId} AND status NOT IN ('closed', 'rejected')
    `;
  }
}

/** Updates the proof anchor message ID for a ticket. */
export async function updateTicketProofAnchor(channelId, messageId) {
  await sql`
    UPDATE tickets
    SET proof_anchor_message_id = ${messageId}
    WHERE channel_id = ${channelId} AND status NOT IN ('closed', 'rejected')
  `;
}

/** Closes a ticket record by channel ID. */
export async function closeTicketRecord(channelId) {
  const result = await sql`
    UPDATE tickets
    SET status = 'closed', closed_at = NOW()
    WHERE channel_id = ${channelId} AND status NOT IN ('closed', 'rejected')
    RETURNING id
  `;
  return result.length > 0;
}

/** Closes the database connection gracefully. */
export async function closeDatabase() {
  try {
    if (typeof sql.end === 'function') {
      await sql.end();
    }
  } catch (err) {
    console.error('Error closing database connection:', err.message);
  }
}

export default sql;
