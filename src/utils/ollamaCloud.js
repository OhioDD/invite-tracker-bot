import config from '../config.js';
import { validateProofAgainstInvitees } from './inviteProof.js';

const DM_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    username: { type: 'string', description: 'Discord username in DM header' },
    has_chat_messages: {
      type: 'boolean',
      description: 'True if real message bubbles/text visible (not empty chat)'
    },
    claimer_sent_messages: {
      type: 'boolean',
      description: 'True if the claimer clearly sent messages in this DM (not header-only)'
    },
    is_join4join: {
      type: 'boolean',
      description: 'True if conversation is join4join / mutual server join deal'
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low', 'none'],
      description: 'How confident join4join detection is'
    },
    evidence: {
      type: 'string',
      description: 'Brief note on what you saw in the chat'
    }
  },
  required: [
    'username',
    'has_chat_messages',
    'claimer_sent_messages',
    'is_join4join',
    'confidence',
    'evidence'
  ]
};

const PROOF_VERIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    is_discord_dm: {
      type: 'boolean',
      description: 'True if images are Discord direct message (private 1-on-1) screens'
    },
    shows_full_dm_header: {
      type: 'boolean',
      description: 'True if username is visible at top of DM (full screenshot, not tiny crop)'
    },
    is_cropped_or_unreadable: {
      type: 'boolean',
      description: 'True if too small/blurry to read message text or usernames'
    },
    detected_dm_usernames: {
      type: 'array',
      items: { type: 'string' },
      description: 'Discord usernames visible in DM headers'
    },
    dm_reviews: {
      type: 'array',
      items: DM_REVIEW_SCHEMA,
      description: 'Per-DM analysis including join4join check'
    },
    contains_join4join: {
      type: 'boolean',
      description: 'True if ANY reviewed DM is join4join'
    },
    approved: { type: 'boolean' },
    reason: { type: 'string' }
  },
  required: [
    'is_discord_dm',
    'shows_full_dm_header',
    'is_cropped_or_unreadable',
    'detected_dm_usernames',
    'dm_reviews',
    'contains_join4join',
    'approved',
    'reason'
  ]
};

/** Extracts JSON from AI model response text, trying multiple parse strategies. */
function extractJsonFromModelText(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // continue
    }
  }

  return null;
}

/** Normalizes AI proof verification response into a consistent shape. */
function normalizeAiProof(parsed) {
  const detected = parsed.detected_dm_usernames ?? parsed.detected_usernames ?? parsed.usernames ?? [];
  const list = Array.isArray(detected) ? detected : [];

  const dm_reviews = Array.isArray(parsed.dm_reviews)
    ? parsed.dm_reviews.map((r) => ({
        username: String(r.username ?? ''),
        has_chat_messages: Boolean(r.has_chat_messages ?? r.has_message_bubbles ?? false),
        claimer_sent_messages: Boolean(
          r.claimer_sent_messages ?? r.inviter_sent_messages ?? false
        ),
        is_join4join: Boolean(r.is_join4join),
        confidence: String(r.confidence ?? 'none').toLowerCase(),
        evidence: String(r.evidence ?? '')
      }))
    : [];

  const containsJoin4Join =
    Boolean(parsed.contains_join4join) ||
    dm_reviews.some(
      (r) => r.is_join4join && (r.confidence === 'high' || r.confidence === 'medium')
    );

  return {
    is_discord_dm: Boolean(parsed.is_discord_dm ?? parsed.isDiscordDm ?? true),
    shows_full_dm_header: Boolean(
      parsed.shows_full_dm_header ?? parsed.showsFullDmHeader ?? true
    ),
    is_cropped_or_unreadable: Boolean(
      parsed.is_cropped_or_unreadable ?? parsed.isCropped ?? false
    ),
    detected_dm_usernames: list.map((u) => String(u)),
    dm_reviews,
    contains_join4join: containsJoin4Join,
    approved: Boolean(parsed.approved),
    reason: String(parsed.reason ?? parsed.explanation ?? 'No reason')
  };
}

const OLLAMA_TIMEOUT = 30_000;

/** Sends a chat request to the Ollama Cloud API with timeout handling. */
async function ollamaChat({ messages, format, model = config.ollamaCloudModel }) {
  if (!config.ollamaApiKey) {
    throw new Error('OLLAMA_API_KEY is not set in .env');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('Ollama request timed out'), OLLAMA_TIMEOUT);

  try {
    const response = await fetch(`${config.ollamaCloudHost}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ollamaApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const msg = data.error || response.statusText || `HTTP ${response.status}`;
      if (response.status === 429) {
        throw new Error('Ollama Cloud usage limit reached. Try again later or check ollama.com/settings.');
      }
      throw new Error(`Ollama Cloud error: ${msg}`);
    }

    if (data.error) {
      throw new Error(data.error);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify proof images match recorded invitees (by username) on main server.
 */
export async function verifyDmProofScreenshots(
  images,
  expectedInvitees,
  inviterId,
  inviterUsername
) {
  const expectedCount = expectedInvitees.filter((p) => p.id !== inviterId).length;

  if (!images.length) {
    return {
      approved: false,
      reason: 'No images were provided.',
      legitimate_dm_count: 0,
      meets_count: false
    };
  }

  const claimer = inviterUsername ? `@${inviterUsername}` : 'the claimer';

  function formatExpectation(p) {
    const parts = [`@${p.username}`];
    if (p.globalName && p.globalName !== p.username) {
      parts.push(`"${p.globalName}"`);
    }
    return parts.join(' / ');
  }

  const requiredLines = expectedInvitees
    .filter((p) => p.id !== inviterId)
    .map((p) => `- ${formatExpectation(p)}`);

  const prompt = `You verify Discord invite claim proof. Read ALL visible message text carefully in every screenshot.

Claimer (must appear as sender in DMs): ${claimer}
Required invitees — list EITHER name that appears in the DM header:
${requiredLines.join('\n')}

IMPORTANT about Discord DM headers: The header shows the person's GLOBAL NAME (e.g. "Mike") in large text, with the @username (e.g. "@mike_123") in smaller text below it. You may see either or both in the screenshot. Report ALL names you see in detected_dm_usernames.

=== REAL CONVERSATION — MUST REJECT IF FAKE ===
Reject if screenshots are ONLY a profile panel, ONLY the DM header, empty chat, or no message history.
Each required DM must show:
- has_chat_messages=true (message bubbles / lines of chat visible)
- claimer_sent_messages=true (${claimer} sent at least one message — usually right-side bubbles in Discord dark theme)

Random/old DMs with no claimer messages = REJECT. Header + avatar only = REJECT.

=== JOIN4JOIN (J4J) — MUST REJECT ===
Join4join means a MUTUAL deal: "join my server and I will join yours" (both farming invite rewards). We do NOT accept this.

Flag is_join4join=true if you see ANY of these (including subtle/indirect):
- "join my server" + "I'll join yours" (or reverse order)
- j4j, J4J, join4join, join 4 join, join for join, j for j
- mutual / both join each other's server
- "you join mine I join yours", fair trade joins, swap joins
- offering their server invite link ONLY in exchange for joining yours
- both sides agree each will join the other's server for rewards

Legitimate invite (NOT join4join): one-sided invite to YOUR server only, no promise to join their server back.

For EACH DM screenshot, one dm_reviews entry: username, has_chat_messages, claimer_sent_messages, is_join4join, confidence, evidence.

Set contains_join4join=true if ANY dm has join4join with medium or high confidence.

=== OTHER RULES ===
1. Discord **DM** only, not server/group chats.
2. shows_full_dm_header=false if name bar not visible.
3. is_cropped_or_unreadable=true if unreadable.
4. detected_dm_usernames = ALL names visible in DM headers (both global name AND @username).
5. approved=true ONLY if: at least one name per required invitee matches, real back-and-forth chat, claimer messaged each person, no J4J.

When in doubt on conversation authenticity → approved=false.

JSON only.`;

  const data = await ollamaChat({
    messages: [
      {
        role: 'user',
        content: prompt,
        images: images.map((img) => img.base64)
      }
    ],
    format: PROOF_VERIFICATION_SCHEMA
  });

  const raw = data.message?.content;
  const parsed = extractJsonFromModelText(raw);

  if (!parsed) {
    console.error('AI raw response (parse failed):', raw?.slice?.(0, 800));
    return {
      approved: false,
      reason: 'Could not read images. Upload full DM screenshots with usernames visible.',
      legitimate_dm_count: 0,
      meets_count: false
    };
  }

  const ai = normalizeAiProof(parsed);
  return validateProofAgainstInvitees(ai, expectedInvitees, inviterId, expectedCount);
}

/** Downloads an attachment and converts it to a base64 string with MIME type. */
export async function attachmentToBase64(attachment) {
  const maxBytes = 4 * 1024 * 1024;
  if (attachment.size > maxBytes) {
    throw new Error(`Image too large (max 4MB): ${attachment.name}`);
  }

  const contentType = attachment.contentType || '';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Not an image: ${attachment.name}`);
  }

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to download ${attachment.name}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    base64: buffer.toString('base64'),
    mimeType: contentType
  };
}
