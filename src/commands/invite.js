import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getValidInviteCount } from '../database/db.js';
import config from '../config.js';
import { formatCountedInvitees } from '../utils/inviteDisplay.js';

export const data = new SlashCommandBuilder()
  .setName('invite')
  .setDescription('Check valid invite count (main server)')
  .addUserOption((opt) =>
    opt.setName('user').setDescription('User to check').setRequired(true)
  );

/** Checks valid invite count for a user. */
export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user');
  const count = await getValidInviteCount(target.id, config.mainGuildId);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Valid invites')
    .setDescription(`**${target.tag}** — **${count}** valid invite(s) on the main server.`)
    .setThumbnail(target.displayAvatarURL())
    .setTimestamp();

  const counted = await formatCountedInvitees(interaction.client, config.mainGuildId, target.id);
  if (counted) {
    embed.addFields({ name: 'Counted', value: counted, inline: false });
  }

  await interaction.editReply({ embeds: [embed] });
}
