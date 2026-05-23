import { MessageFlags, PermissionsBitField, ChannelType } from 'discord.js';
import { getGuildConfig, insertActiveTicket, getValidInviteCount } from '../database/db.js';
import { sendFirstTicketMessage } from './ticketFlow.js';
import { buildTicketChannelName } from './channelNames.js';
import { cacheTicket } from './ticketCache.js';
import { reconcileTicketsForUser } from './ticketReconcile.js';
import config from '../config.js';
import { getStaffRoleIds } from './staffRoles.js';

/** Gets guild settings including staff role IDs and ticket category ID. */
async function getGuildSettings(guildId) {
  const [staffRoleIds, ticketCategoryId] = await Promise.all([
    getStaffRoleIds(guildId),
    getGuildConfig(guildId, 'ticket_category_id')
  ]);
  return { staffRoleIds, ticketCategoryId };
}

/** Creates a ticket channel and inserts a DB record for the user. */
export async function createTicket(interaction) {
  let ticketChannel = null;

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const { guild, user } = interaction;

    if (!guild || guild.id !== config.claimGuildId) {
      await interaction.editReply({ content: 'This button can only be used on the claim server.' });
      return;
    }

    const { staffRoleIds, ticketCategoryId } = await getGuildSettings(guild.id);

    if (!ticketCategoryId) {
      await interaction.editReply({
        content: 'Ticket category is not configured. An admin must run `/claim category`.'
      });
      return;
    }

    if (staffRoleIds.length === 0) {
      await interaction.editReply({
        content: 'No staff roles configured. An admin must run `/staff add` at least once.'
      });
      return;
    }

    const category = guild.channels.cache.get(ticketCategoryId);
    if (!category) {
      await interaction.editReply({ content: 'Ticket category not found. Contact an administrator.' });
      return;
    }

    const botMember = guild.members.me;
    if (botMember) {
      const perms = category.permissionsFor(botMember);
      if (!perms?.has(['ManageChannels', 'ViewChannel', 'SendMessages'])) {
        await interaction.editReply({
          content: 'Bot needs **Manage Channels**, **View Channel**, and **Send Messages** in the ticket category. Ask an admin.'
        });
        return;
      }
    }

    const existing = await reconcileTicketsForUser(guild, user.id);
    if (existing) {
      await interaction.editReply({
        content: `You already have an open ticket: <#${existing.channel.id}>`
      });
      return;
    }

    const channelName = buildTicketChannelName(user.username, user.id);

    const permissionOverwrites = [
      {
        id: guild.id,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.AttachFiles
        ]
      }
    ];

    for (const roleId of staffRoleIds) {
      permissionOverwrites.push({
        id: roleId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageMessages,
          PermissionsBitField.Flags.AttachFiles
        ]
      });
    }

    ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: ticketCategoryId,
      permissionOverwrites,
      reason: 'Invite claim ticket'
    });

    const inviteCount = await getValidInviteCount(user.id, config.mainGuildId);
    const ticket = await insertActiveTicket(ticketChannel.id, user.id, guild.id, inviteCount);

    if (!ticket) {
      await ticketChannel.delete('Duplicate ticket blocked').catch(() => {});
      const again = await reconcileTicketsForUser(guild, user.id);
      await interaction.editReply({
        content: again
          ? `You already have an open ticket: <#${again.channel.id}>`
          : 'You already have an open ticket. Please wait for it to be resolved.'
      });
      return;
    }

    cacheTicket(ticket);
    await sendFirstTicketMessage(ticketChannel, user.id);

    await interaction.editReply({
      content: `Ticket created: <#${ticketChannel.id}>`
    });
  } catch (error) {
    if (ticketChannel) {
      await ticketChannel.delete('Ticket creation failed').catch(() => {});
    }

    console.error('Error creating ticket:', error);
    const errorMessage = 'An error occurred while creating your ticket';
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: errorMessage }).catch(() => {});
      } else {
        await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } catch (replyError) {
      console.error('Error sending error message:', replyError);
    }
  }
}
