import { createTicket } from '../utils/ticketSystem.js';
import {
  BUTTON_SUBMIT_PROOF,
  BUTTON_CLOSE_ZERO,
  BUTTON_ENTER_CLAIM,
  MODAL_CLAIM_SUBMIT,
  handleSubmitProofButton,
  handleCloseZeroTicket,
  handleEnterClaimButton,
  handleClaimModalSubmit
} from '../utils/ticketFlow.js';
import { checkRateLimit } from '../utils/rateLimiter.js';

export const name = 'interactionCreate';

export async function execute(interaction) {
  try {
    if (interaction.isButton()) {
      const cmd = interaction.customId === 'claim_ticket' ? 'claim' : 'invite';
      const remaining = checkRateLimit(interaction.user.id, cmd);
      if (remaining) {
        if (interaction.deferred) return;
        await interaction.reply({
          content: `Slow down. Try again in ${remaining}s.`,
          ephemeral: true
        }).catch(() => {});
        return;
      }
      if (interaction.customId === 'claim_ticket') {
        await createTicket(interaction);
        return;
      }
      if (interaction.customId === BUTTON_SUBMIT_PROOF) {
        await handleSubmitProofButton(interaction);
        return;
      }
      if (interaction.customId === BUTTON_CLOSE_ZERO) {
        await handleCloseZeroTicket(interaction);
        return;
      }
      if (interaction.customId === BUTTON_ENTER_CLAIM) {
        await handleEnterClaimButton(interaction);
        return;
      }
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === MODAL_CLAIM_SUBMIT) {
      await handleClaimModalSubmit(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found`);
      return;
    }

    const remaining = checkRateLimit(interaction.user.id, interaction.commandName);
    if (remaining) {
      await interaction.reply({
        content: `Slow down. Try again in ${remaining}s.`,
        ephemeral: true
      }).catch(() => {});
      return;
    }

    await command.execute(interaction);
  } catch (error) {
    console.error('Interaction error:', error);

    const errorMessage = 'Something went wrong. Please try again.';

    try {
      if (interaction.isButton()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: errorMessage }).catch(() => {});
        } else {
          await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
        }
        return;
      }

      if (interaction.isChatInputCommand()) {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: errorMessage, ephemeral: true });
        } else {
          await interaction.reply({ content: errorMessage, ephemeral: true });
        }
      }
    } catch (replyError) {
      console.error('Error sending error message:', replyError);
    }
  }
}
