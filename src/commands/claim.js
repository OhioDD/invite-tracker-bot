import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags
} from 'discord.js';
import { setGuildConfig } from '../database/db.js';
import config from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('claim')
  .setDescription('Claim server setup')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Post the claim button in this channel')
  )
  .addSubcommand((sub) =>
    sub
      .setName('category')
      .setDescription('Set the category where tickets are created')
      .addChannelOption((opt) =>
        opt.setName('category').setDescription('Ticket category').setRequired(true)
      )
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.guildId !== config.claimGuildId) {
    await interaction.editReply({ content: 'Use this on the **claim server** only.' });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'setup') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('claim_ticket')
        .setLabel('Claim')
        .setStyle(ButtonStyle.Primary)
    );

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Claim')
      .setDescription('Open a ticket. Your main-server invite count is checked automatically.');

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.editReply({ content: 'Claim panel posted.' });
    return;
  }

  if (sub === 'category') {
    const category = interaction.options.getChannel('category');
    if (category.type !== ChannelType.GuildCategory) {
      await interaction.editReply({ content: 'Please choose a **category** channel.' });
      return;
    }

    await setGuildConfig(interaction.guild.id, 'ticket_category_id', category.id);
    await interaction.editReply({ content: `Ticket category set to ${category.toString()}.` });
  }
}
