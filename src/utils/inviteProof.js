import config from '../config.js';
import sql from '../database/db.js';

/** Invitees who need DM proof — never the claimer themselves. */
export function filterProofInvitees(profiles, inviterId) {
  return profiles.filter((p) => p.id && p.id !== inviterId);
}

/** Valid invitees still on main server (for proof matching). */
export async function getValidInviteeProfiles(mainGuild, inviterId) {
  const rows = await sql`
    SELECT invitee_id
    FROM invites
    WHERE inviter_id = ${inviterId}
      AND invitee_id <> ${inviterId}
      AND guild_id = ${config.mainGuildId}
      AND is_fake = FALSE
      AND is_left = FALSE
      AND is_vanity = FALSE
  `;

  const results = await Promise.allSettled(
    rows.map(async (row) => {
      try {
        const member = await mainGuild.members.fetch(row.invitee_id);
        const u = member.user;
        return {
          id: row.invitee_id,
          username: u.username,
          globalName: u.globalName ?? u.username
        };
      } catch {
        try {
          const user = await mainGuild.client.users.fetch(row.invitee_id);
          return {
            id: row.invitee_id,
            username: user.username,
            globalName: user.globalName ?? user.username
          };
        } catch {
          console.warn(`Could not resolve invitee ${row.invitee_id} for proof matching`);
          return null;
        }
      }
    })
  );

  return results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
}

/** Names to check in DM headers — covers both global name and @username. */
export function proofNames(profile) {
  return [profile.username, profile.globalName].filter(Boolean);
}

/** Normalizes a name for comparison (lowercase, strip @, trim). */
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().replace(/^@/, '').trim();
}

/** Matches two names flexibly (exact or suffix match). */
function matchName(req, detected) {
  const a = normalizeName(req);
  const b = normalizeName(detected);
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/**
 * Only images uploaded AFTER the last bot rejection / proof instructions.
 * Old rejected screenshots are never scanned again.
 */
async function fetchMessagesPage(channel, lastId, userId, seen, attachments) {
  const fetchOptions = { limit: 100 };
  if (lastId) fetchOptions.after = lastId;

  const messages = await channel.messages.fetch(fetchOptions);
  if (messages.size === 0) return null;

  const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  for (const message of sorted) {
    if (message.author.id !== userId) continue;
    for (const attachment of message.attachments.values()) {
      if (!attachment.contentType?.startsWith('image/')) continue;
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      attachments.push(attachment);
    }
  }

  return messages.last()?.id;
}

async function fetchPagesRecursively(channel, userId, seen, attachments, lastId, pagesFetched) {
  if (pagesFetched >= 5) return;
  const nextId = await fetchMessagesPage(channel, lastId, userId, seen, attachments);
  if (!nextId) return;
  return fetchPagesRecursively(channel, userId, seen, attachments, nextId, pagesFetched + 1);
}

/**
 * Only images uploaded AFTER the last bot rejection / proof instructions.
 * Old rejected screenshots are never scanned again.
 */
export async function collectProofImagesSince(channel, userId, afterMessageId) {
  const attachments = [];
  const seen = new Set();
  await fetchPagesRecursively(channel, userId, seen, attachments, afterMessageId, 0);
  return attachments;
}

/**
 * Match AI-detected DM usernames to recorded invitees.
 * Checks against both @username and global name (DM headers show the global name).
 */
export function validateProofAgainstInvitees(ai, expectedInvitees, inviterId, expectedCount) {
  const invitees = expectedInvitees.filter((p) => p.id !== inviterId);

  const requiredFlat = [];
  for (const p of invitees) {
    requiredFlat.push(...proofNames(p));
  }

  const detected = (ai.detected_dm_usernames || [])
    .map((u) => normalizeName(u))
    .filter(Boolean);

  function isDetected(name) {
    const n = normalizeName(name);
    return n && detected.some((d) => matchName(n, d));
  }

  const matched = invitees.filter((p) => proofNames(p).some((n) => isDetected(n)));
  const missing = invitees.filter((p) => !proofNames(p).some((n) => isDetected(n)));
  const extra = detected.filter((d) => !requiredFlat.some((r) => matchName(r, d)));

  const matchedNames = matched.flatMap((p) => proofNames(p)).filter((n) => isDetected(n));
  const missingNames = missing.flatMap((p) => proofNames(p)).filter((n) => !isDetected(n));

  if (ai.is_cropped_or_unreadable || ai.shows_full_dm_header === false) {
    return {
      approved: false,
      reason: 'Full DM screenshots required — name at top, readable chat. Not cropped, not server channels.',
      legitimate_dm_count: matched.length,
      matched_usernames: matchedNames,
      missing_usernames: missingNames,
      join4join_detected: false
    };
  }

  if (!ai.is_discord_dm) {
    return {
      approved: false,
      reason: ai.reason || 'Must be private DMs, not server chats.',
      legitimate_dm_count: 0,
      matched_usernames: matchedNames,
      missing_usernames: missingNames,
      join4join_detected: false
    };
  }

  const j4jHits = (ai.dm_reviews || []).filter(
    (r) =>
      r.is_join4join &&
      (r.confidence === 'high' || r.confidence === 'medium')
  );

  if (ai.contains_join4join || j4jHits.length > 0) {
    const details = j4jHits
      .map((r) => `@${normalizeName(r.username)}: ${r.evidence}`)
      .filter((line) => line.length > 3)
      .join('\n');

    return {
      approved: false,
      reason: details ? `Join4join not allowed. ${details}` : 'Join4join not allowed.',
      legitimate_dm_count: matched.length,
      matched_usernames: matchedNames,
      missing_usernames: missingNames,
      join4join_detected: true
    };
  }

  const conversationFails = [];
  for (const p of invitees) {
    const names = proofNames(p);
    const review = (ai.dm_reviews || []).find((r) => {
      const u = normalizeName(r.username);
      return u && names.some((n) => matchName(n, u));
    });

    if (!review) {
      conversationFails.push(`@${p.username}: no DM review`);
      continue;
    }
    if (!review.has_chat_messages) {
      conversationFails.push(`@${p.username}: no chat visible`);
    } else if (!review.claimer_sent_messages) {
      conversationFails.push(`@${p.username}: you must have messaged them`);
    }
  }

  if (conversationFails.length > 0) {
    return {
      approved: false,
      reason: `Real DM conversation required. ${conversationFails.join('; ')}.`,
      legitimate_dm_count: matched.length,
      matched_usernames: matchedNames,
      missing_usernames: missingNames,
      join4join_detected: false
    };
  }

  if (matched.length < expectedCount) {
    const requiredList = requiredFlat.map((u) => `@${normalizeName(u)}`).join(', ');
    const missingList = missingNames.map((u) => `@${normalizeName(u)}`).join(', ');
    const extraList = extra.map((u) => `@${u}`).join(', ');
    const extraNote = extra.length > 0 ? ` Wrong user in proof: ${extraList}.` : '';

    return {
      approved: false,
      reason: `Missing DM for ${missingList || 'unknown'}. Need ${requiredList}.${extraNote}`,
      legitimate_dm_count: matched.length,
      matched_usernames: matchedNames,
      missing_usernames: missingNames,
      join4join_detected: false
    };
  }

  if (!ai.approved) {
    const reasonLower = (ai.reason || '').toLowerCase();
    const aiMentionsJ4j =
      reasonLower.includes('join4join') ||
      reasonLower.includes('join 4 join') ||
      reasonLower.includes('j4j') ||
      reasonLower.includes('mutual join');

    if (aiMentionsJ4j) {
      return {
        approved: false,
        reason: 'Join4join not allowed.',
        legitimate_dm_count: matched.length,
        matched_usernames: matchedNames,
        missing_usernames: missingNames,
        join4join_detected: true
      };
    }

    return {
      approved: false,
      reason: ai.reason || 'Proof rejected.',
      legitimate_dm_count: matched.length,
      matched_usernames: matchedNames,
      missing_usernames: missingNames,
      join4join_detected: false
    };
  }

  const okNames = matchedNames.map((u) => '@' + normalizeName(u)).join(', ');
  return {
    approved: true,
    reason: `OK: ${okNames}`,
    legitimate_dm_count: matched.length,
    matched_usernames: matchedNames,
    missing_usernames: [],
    join4join_detected: false
  };
}
