import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import config from '../config.js';
import {
  getTicketByChannel,
  updateTicketWorkflow,
  updateTicketProofAnchor,
  getValidInviteCount
} from '../database/db.js';
import { cacheTicket, getCachedTicket, patchCachedTicket } from './ticketCache.js';
import { attachmentToBase64, verifyDmProofScreenshots } from './ollamaCloud.js';
import { getStaffRoleIds, staffMentionString } from './staffRoles.js';
import { closeTicketChannel } from './ticketClose.js';
import { buildVerifiedChannelName } from './channelNames.js';
import { formatCountedInvitees } from './inviteDisplay.js';
import {
  getValidInviteeProfiles,
  filterProofInvitees,
  collectProofImagesSince
} from './inviteProof.js';

export const BUTTON_SUBMIT_PROOF = 'ticket_submit_proof';
export const BUTTON_CLOSE_ZERO = 'ticket_close_zero';
export const BUTTON_ENTER_CLAIM = 'ticket_enter_claim';
export const MODAL_CLAIM_SUBMIT = 'ticket_claim_modal';
const MODAL_CLAIM_FIELD = 'claim_name';

/** Creates a compact embed with color, title, and description. */
function compactEmbed(color, title, line) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(line);
}

/** Formats invitees as an @username list separated by dots. */
function inviteeList(invitees) {
  return invitees.map((p) => `@${p.username}`).join(' · ');
}

/** Creates a Submit Proof button row. */
function proofButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_SUBMIT_PROOF)
      .setLabel('Submit Proof')
      .setStyle(ButtonStyle.Success)
  );
}

/** Creates an Enter (claim) button row. */
function enterClaimButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_ENTER_CLAIM)
      .setLabel('Enter')
      .setStyle(ButtonStyle.Primary)
  );
}

/** Formats a proof rejection message with reason and required invitees. */
function formatRejection(result, proofCount, requiredInvitees) {
  const need = inviteeList(requiredInvitees);
  let reason = (result.reason || 'Not approved.').replace(/\*\*/g, '').trim();
  if (reason.length > 200) reason = `${reason.slice(0, 197)}…`;
  return `${reason}\n\nNeed ${proofCount} DM(s): ${need}`;
}

/** Resolves a ticket by channel ID, using cache first. */
async function resolveTicket(channelId) {
  const cached = getCachedTicket(channelId);
  if (cached) return cached;

  const ticket = await getTicketByChannel(channelId);
  if (ticket) cacheTicket(ticket);
  return ticket;
}

/** Checks if the interaction user owns the given ticket. */
function isTicketOwner(interaction, ticket) {
  return interaction.user.id === ticket.user_id;
}

/** Saves the proof anchor message ID for paginated image collection. */
async function setProofAnchor(channelId, message) {
  if (message?.id) {
    await updateTicketProofAnchor(channelId, message.id);
    patchCachedTicket(channelId, { proof_anchor_message_id: message.id });
  }
}

/** Resolves ticket and validates ownership, sending error replies on failure. */
async function resolveOwnTicket(interaction) {
  const ticket = await resolveTicket(interaction.channelId);
  if (!ticket) {
    await interaction.editReply({ content: 'No ticket found.' });
    return null;
  }
  if (!isTicketOwner(interaction, ticket)) {
    await interaction.editReply({ content: 'Not your ticket.' });
    return null;
  }
  return ticket;
}

/** Sends the initial ticket message based on invite count (zero or with proof buttons). */
export async function sendFirstTicketMessage(channel, userId) {
  const count = await getValidInviteCount(userId, config.mainGuildId);
  const counted =
    (await formatCountedInvitees(channel.client, config.mainGuildId, userId)) ||
    '(loading…)';

  if (count === 0) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(BUTTON_CLOSE_ZERO)
        .setLabel('Close ticket')
        .setStyle(ButtonStyle.Secondary)
    );

    await channel.send({
      embeds: [compactEmbed(0xed4245, '0 invites', 'No valid invites on the main server.')],
      components: [row]
    }).then((msg) => setProofAnchor(channel.id, msg));

    return;
  }

  await channel.send({
    embeds: [
      compactEmbed(
        0x5865f2,
        `${count} invite${count === 1 ? '' : 's'}`,
        `${counted}\nUpload full DM proof → Submit Proof`
      )
    ],
    components: [proofButtons()]
  }).then((msg) => setProofAnchor(channel.id, msg));
}

/** Sends a proof rejection message with retry button. */
async function sendProofRejected(channel, proofCount, result, requiredInvitees) {
  const msg = await channel.send({
    embeds: [
      compactEmbed(0xed4245, 'Not approved', formatRejection(result, proofCount, requiredInvitees))
    ],
    components: [proofButtons()]
  });

  await setProofAnchor(channel.id, msg);
  return msg;
}

/** Sends an awaiting claim name message with Enter button. */
async function sendAwaitingClaimName(channel, verifiedList) {
  const msg = await channel.send({
    embeds: [
      compactEmbed(
        0x57f287,
        'Proof passed',
        `${verifiedList}\nClick **Enter** and type what you are claiming.`
      )
    ],
    components: [enterClaimButton()]
  });
  await setProofAnchor(channel.id, msg);
  return msg;
}

/** Handles the Enter Claim button click, showing a claim name modal. */
export async function handleEnterClaimButton(interaction) {
  const ticket = await resolveTicket(interaction.channelId);
  if (!ticket) {
    await interaction.reply({ content: 'No ticket found.', ephemeral: true });
    return;
  }

  if (!isTicketOwner(interaction, ticket)) {
    await interaction.reply({ content: 'Not your ticket.', ephemeral: true });
    return;
  }

  if (ticket.status !== 'awaiting_claim') {
    await interaction.reply({
      content: 'You already submitted your claim name or cannot use this yet.',
      ephemeral: true
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(MODAL_CLAIM_SUBMIT)
    .setTitle('What are you claiming?')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(MODAL_CLAIM_FIELD)
          .setLabel('Reward / item name')
          .setStyle(TextInputStyle.Short)
          .setMinLength(2)
          .setMaxLength(32)
          .setPlaceholder('e.g. nitro, robux, rank')
          .setRequired(true)
      )
    );

  await interaction.showModal(modal);
}

/** Handles claim modal submission, renames channel and updates workflow. */
export async function handleClaimModalSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const ticket = await resolveOwnTicket(interaction);
    if (!ticket) return;

    if (ticket.status !== 'awaiting_claim') {
      await interaction.editReply({ content: 'Claim name already submitted.' });
      return;
    }

    const claimName = interaction.fields.getTextInputValue(MODAL_CLAIM_FIELD).trim();
    const newName = buildVerifiedChannelName(interaction.user.username, claimName);

    await interaction.channel.setName(newName, 'Proof verified — user claim name');

    await updateTicketWorkflow(interaction.channelId, {
      status: 'waiting_payout',
      verificationNote: claimName
    });
    patchCachedTicket(interaction.channelId, { status: 'waiting_payout' });

    const staffRoleIds = await getStaffRoleIds(interaction.guild.id);
    const staffPing = staffRoleIds.length > 0 ? staffMentionString(staffRoleIds) : null;

    const counted = await formatCountedInvitees(
      interaction.client,
      config.mainGuildId,
      ticket.user_id
    );

    const displayName = counted ?? '@' + interaction.user.username;
    await interaction.channel.send({
      content: staffPing ?? null,
      embeds: [
        compactEmbed(
          0x57f287,
          'Payout queue',
          `${displayName}\nClaim: ${claimName}`
        )
      ],
      allowedMentions: staffPing ? { roles: staffRoleIds } : { parse: [] }
    });

    await interaction.editReply({ content: `Ticket renamed to #${newName}. Staff notified.` });
  } catch (error) {
    console.error('Claim modal error:', error);
    await interaction.editReply({ content: 'Could not rename ticket. Contact staff.' });
  }
}

/** Handles the Submit Proof button click, runs AI verification. */
export async function handleSubmitProofButton(interaction) {
  await interaction.deferReply();

  try {
    const ticket = await resolveOwnTicket(interaction);
    if (!ticket) return;

    if (ticket.status === 'no_invites') {
      await interaction.editReply({ content: '0 invites. Nothing to claim.' });
      return;
    }

    if (ticket.status !== 'awaiting_proof') {
      let msg;
      if (ticket.status === 'waiting_payout') {
        msg = 'Already in payout queue.';
      } else if (ticket.status === 'awaiting_claim') {
        msg = 'Proof passed — click **Enter** to name your claim.';
      } else if (ticket.status === 'verifying') {
        msg = 'Already checking proof.';
      } else {
        msg = 'Cannot submit proof now.';
      }
      await interaction.editReply({ content: msg });
      return;
    }

    const mainGuild = await interaction.client.guilds.fetch(config.mainGuildId);
    const inviteeProfiles = await getValidInviteeProfiles(mainGuild, ticket.user_id);
    const requiredInvitees = filterProofInvitees(inviteeProfiles, ticket.user_id);
    const proofCount = requiredInvitees.length;
    const requiredList = inviteeList(requiredInvitees);

    if (proofCount <= 0) {
      await interaction.editReply({ content: 'No valid invitees found on the main server.' });
      return;
    }

    const anchorId = ticket.proof_anchor_message_id ?? null;
    const attachments = await collectProofImagesSince(
      interaction.channel,
      ticket.user_id,
      anchorId
    );

    if (attachments.length === 0) {
      await interaction.editReply({
        content: anchorId
          ? `Upload ${proofCount} new screenshot(s) after the last bot message.`
          : `Upload ${proofCount} screenshot(s) first.`
      });
      return;
    }

    if (attachments.length < proofCount) {
      await interaction.editReply({
        content: `${attachments.length}/${proofCount} images — upload more, then submit.`
      });
      return;
    }

    const toScan = attachments.slice(-proofCount);

    await updateTicketWorkflow(interaction.channelId, { status: 'verifying' });
    patchCachedTicket(interaction.channelId, { status: 'verifying' });

    await interaction.editReply({
      embeds: [compactEmbed(0xfee75c, 'Checking', requiredList)]
    });

    const images = [];
    for (const att of toScan) {
      images.push(await attachmentToBase64(att));
    }

    const result = await verifyDmProofScreenshots(
      images,
      requiredInvitees,
      ticket.user_id,
      interaction.user.username
    );

    if (result.approved) {
      const verified =
        result.matched_usernames?.map((u) => `@${u}`).join(' · ') || requiredList;

      await updateTicketWorkflow(interaction.channelId, {
        status: 'awaiting_claim',
        verificationNote: result.reason
      });
      patchCachedTicket(interaction.channelId, { status: 'awaiting_claim' });

      await sendAwaitingClaimName(interaction.channel, verified);
      await interaction.editReply({
        embeds: [compactEmbed(0x57f287, 'Proof passed', verified)]
      });
    } else {
      await updateTicketWorkflow(interaction.channelId, { status: 'awaiting_proof' });
      patchCachedTicket(interaction.channelId, { status: 'awaiting_proof' });

      await sendProofRejected(proofCount, result, requiredInvitees);
      await interaction.editReply({ content: 'Not approved.' });
    }
  } catch (error) {
    console.error('Proof verification error:', error);

    const isApiError =
      error.message?.includes('Ollama') ||
      error.message?.includes('429') ||
      error.message?.includes('OLLAMA');

    await updateTicketWorkflow(interaction.channelId, { status: 'awaiting_proof' }).catch(() => {});
    patchCachedTicket(interaction.channelId, { status: 'awaiting_proof' });

    const errMsg = await interaction.channel.send({
      embeds: [
        compactEmbed(
          0xed4245,
          isApiError ? 'AI unavailable' : 'Error',
          isApiError ? 'Try again shortly.' : 'Upload full DM screenshots and try again.'
        )
      ],
      components: [proofButtons()]
    });
    await setProofAnchor(interaction.channelId, errMsg);
    await interaction.editReply({ content: 'Error.' }).catch(() => {});
  }
}

/** Handles the Close Ticket button for zero-invite tickets. */
export async function handleCloseZeroTicket(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const ticket = await resolveOwnTicket(interaction);
    if (!ticket) return;

    if (ticket.status !== 'no_invites') {
      await interaction.editReply({ content: 'Only for zero-invite tickets.' });
      return;
    }

    await interaction.editReply({ content: 'Closing…' });
    await interaction.channel.send({
      embeds: [compactEmbed(0x99aab5, 'Closed', 'Ticket closed.')]
    });
    await closeTicketChannel(interaction.channel, 'User closed — zero invites');
  } catch (error) {
    console.error('Close zero ticket error:', error);
    await interaction.editReply({ content: 'Could not close.' }).catch(() => {});
  }
}
