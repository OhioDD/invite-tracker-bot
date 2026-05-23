import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { addStaffRole, removeStaffRole, getStaffRoleIds } from '../utils/staffRoles.js';
import config from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('staff')
  .setDescription('Manage staff roles for claim tickets')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a staff role')
      .addRoleOption((opt) => opt.setName('role').setDescription('Staff role').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a staff role')
      .addRoleOption((opt) => opt.setName('role').setDescription('Staff role').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List all staff roles'));

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.guildId !== config.claimGuildId) {
    await interaction.editReply({ content: 'Use this on the **claim server** only.' });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const role = interaction.options.getRole('role');
    const { added, ids } = await addStaffRole(interaction.guild.id, role.id);

    if (!added) {
      await interaction.editReply({ content: `${role} is already a staff role.` });
      return;
    }

    await interaction.editReply({
      content: `Added ${role}. Staff roles (${ids.length}): ${ids.map((id) => `<@&${id}>`).join(', ')}`
    });
    return;
  }

  if (sub === 'remove') {
    const role = interaction.options.getRole('role');
    const ids = await removeStaffRole(interaction.guild.id, role.id);

    await interaction.editReply({
      content:
        ids.length > 0
          ? `Removed ${role}. Staff roles (${ids.length}): ${ids.map((id) => `<@&${id}>`).join(', ')}`
          : `Removed ${role}. No staff roles left — use \`/staff add\`.`
    });
    return;
  }

  if (sub === 'list') {
    const ids = await getStaffRoleIds(interaction.guild.id);
    if (ids.length === 0) {
      await interaction.editReply({ content: 'No staff roles set. Use `/staff add`.' });
      return;
    }

    await interaction.editReply({
      content: `Staff roles (${ids.length}): ${ids.map((id) => `<@&${id}>`).join(', ')}`
    });
  }
}
