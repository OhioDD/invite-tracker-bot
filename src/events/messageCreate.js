import { EmbedBuilder } from 'discord.js';
import { getValidInviteCount } from '../database/db.js';
import config from '../config.js';
import { formatCountedInvitees } from '../utils/inviteDisplay.js';

export const name = 'messageCreate';

/** Handles prefix commands like -invite and -i. */
export async function execute(message) {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith('-')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command !== 'invite' && command !== 'i') return;

  try {
    let targetUser;

    if (message.mentions.users.size > 0) {
      targetUser = message.mentions.users.first();
    } else if (args[0]) {
      try {
        targetUser = await message.client.users.fetch(args[0]);
      } catch {
        await message.reply('User not found');
        return;
      }
    } else {
      await message.reply('Usage: `-i @user` or `-invite @user`');
      return;
    }

    const inviteCount = await getValidInviteCount(targetUser.id, config.mainGuildId);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Valid invites')
      .setDescription(`**${targetUser.tag}** — **${inviteCount}** valid invite(s) on the main server.`)
      .setThumbnail(targetUser.displayAvatarURL())
      .setTimestamp();

    const counted = await formatCountedInvitees(
      message.client,
      config.mainGuildId,
      targetUser.id
    );
    if (counted) {
      embed.addFields({ name: 'Counted', value: counted, inline: false });
    }

    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Message command error:', error);
    await message.reply('An error occurred').catch(() => {});
  }
}
