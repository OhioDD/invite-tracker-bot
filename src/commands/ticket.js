import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { reconcileTicketsForUser, closeOrphanTicket } from '../utils/ticketReconcile.js';
import { getActiveTicketByUser } from '../database/db.js';
import { getStaffRoleIds, memberIsStaff } from '../utils/staffRoles.js';
import { closeTicketChannel } from '../utils/ticketClose.js';
import config from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Ticket tools (claim server)')
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Force-close a stuck or open ticket')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('User (defaults to you)').setRequired(false)
      )
  );

/** Handles /ticket close command for staff force-closing tickets. */
export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.guildId !== config.claimGuildId) {
    await interaction.editReply({ content: 'Use this on the **claim server** only.' });
    return;
  }

  const staffIds = await getStaffRoleIds(interaction.guild.id);
  const isStaff =
    memberIsStaff(interaction.member, staffIds) ||
    interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels);

  if (!isStaff) {
    await interaction.editReply({ content: 'You need a staff role to use this.' });
    return;
  }

  const target = interaction.options.getUser('user') ?? interaction.user;
  const existing = await reconcileTicketsForUser(interaction.guild, target.id);

  if (existing?.channel) {
    await closeOrphanTicket(existing.ticket, 'staff close');
    await closeTicketChannel(existing.channel, 'Closed by staff');
    await interaction.editReply({ content: `Closed ticket for **${target.tag}**.` });
    return;
  }

  const ticket = await getActiveTicketByUser(target.id, interaction.guild.id);
  if (ticket) {
    await closeOrphanTicket(ticket, 'staff close');
    await interaction.editReply({
      content: `Closed ticket record for **${target.tag}** (channel was already gone).`
    });
    return;
  }

  await interaction.editReply({ content: `No active ticket found for **${target.tag}**.` });
}
