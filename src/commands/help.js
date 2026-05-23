import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Command list and claim flow');

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Invite Checker')
    .setDescription('All counts are from the **main server**. The claim server is for payouts only.')
    .addFields(
      {
        name: 'Everyone',
        value:
          '`/invite` — Check someone\'s valid invite count\n' +
          '`-i @user` — Same check (quick prefix on any server)',
        inline: false
      },
      {
        name: 'Claim server (admin)',
        value:
          '`/claim setup` — Post the Claim button\n' +
          '`/claim category` — Where tickets are created\n' +
          '`/staff add` — Add a staff role (repeat for multiple)\n' +
          '`/staff remove` — Remove a staff role\n' +
          '`/staff list` — See all staff roles',
        inline: false
      },
      {
        name: 'Main server (admin)',
        value: '`/invites clear` — Wipe a user\'s invite records',
        inline: false
      },
      {
        name: 'Claim server (staff)',
        value: '`/ticket close` — Force-close a ticket',
        inline: false
      },
      {
        name: 'Claim ticket flow',
        value:
          '1. User clicks **Claim** → bot shows main-server invite count\n' +
          '2. If **0** invites → **Close ticket** button (user closes when ready)\n' +
            '3. Upload DM proof → **Submit Proof** → **Enter** claim name → channel renamed → staff payout',
        inline: false
      }
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
