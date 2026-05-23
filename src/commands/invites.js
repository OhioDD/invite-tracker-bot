import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags
} from 'discord.js';
import { clearUserInvites, getInviteHistoryForInviter } from '../database/db.js';
import config from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('invites')
  .setDescription('Manage invite records on the main server')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Show all tracked invites for a user')
      .addUserOption((opt) => opt.setName('user').setDescription('Inviter').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('clear')
      .setDescription('Clear all invites for a user')
      .addUserOption((opt) => opt.setName('user').setDescription('User to clear').setRequired(true))
  );

function inviteeStatus(inviterId, row) {
  if (row.invitee_id === inviterId) return 'self (not counted)';
  if (row.is_left) return 'left';
  if (row.is_fake) return 'fake/alt';
  return 'valid';
}

async function resolveUsername(client, guildId, userId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    return member.user.username;
  } catch {
    try {
      const user = await client.users.fetch(userId);
      return user.username;
    } catch {
      return userId;
    }
  }
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.guildId !== config.mainGuildId) {
    await interaction.editReply({ content: 'Use this on the **main server** only.' });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const target = interaction.options.getUser('user');

  if (sub === 'clear') {
    await clearUserInvites(target.id, config.mainGuildId);

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('Invites cleared')
      .setDescription(`Cleared all records for **${target.tag}**.`)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const rows = await getInviteHistoryForInviter(target.id, config.mainGuildId);

  if (rows.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xFEE75C)
          .setTitle('No records')
          .setDescription(`**${target.tag}** has no invite rows in the database.`)
      ]
    });
    return;
  }

  const lines = [];
  for (const row of rows) {
    const name = await resolveUsername(interaction.client, config.mainGuildId, row.invitee_id);
    lines.push(`@${name} — ${inviteeStatus(target.id, row)}`);
  }

  const valid = rows.filter(
    (r) => r.invitee_id !== target.id && !r.is_fake && !r.is_left
  ).length;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`Invites — ${target.tag}`)
    .setDescription(`**${valid}** valid · ${rows.length} total in DB`)
    .addFields({ name: 'Rows', value: lines.join('\n') || '—', inline: false })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
