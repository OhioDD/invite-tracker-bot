import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { readdir } from 'fs/promises';
import { pathToFileURL } from 'url';
import { join } from 'path';
import config, { validateConfig } from './config.js';
import { initDatabase, cleanupStaleRegistry, closeDatabase } from './database/db.js';
import { initInviteCountCache } from './utils/inviteCountCache.js';
import { syncInviteLedger, takeInviteSnapshot } from './utils/inviteEngine.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  sweepers: {
    messages: {
      interval: 3600,
      lifetime: 1800
    }
  }
});

client.commands = new Collection();

async function loadCommands() {
  try {
    const commandsPath = join(process.cwd(), 'src', 'commands');
    const commandFiles = await readdir(commandsPath);

    for (const file of commandFiles) {
      if (!file.endsWith('.js')) continue;

      const filePath = join(commandsPath, file);
      const fileUrl = pathToFileURL(filePath).href;
      const command = await import(fileUrl);

      if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        console.log(`Loaded command: ${command.data.name}`);
      }
    }
  } catch (error) {
    console.error('Error loading commands:', error);
  }
}

async function loadEvents() {
  try {
    const eventsPath = join(process.cwd(), 'src', 'events');
    const eventFiles = await readdir(eventsPath);

    for (const file of eventFiles) {
      if (!file.endsWith('.js')) continue;

      const filePath = join(eventsPath, file);
      const fileUrl = pathToFileURL(filePath).href;
      const event = await import(fileUrl);

      if (event.once) {
        client.once(event.name, (...args) => event.execute(...args));
      } else {
        client.on(event.name, (...args) => event.execute(...args));
      }
      console.log(`Loaded event: ${event.name}`);
    }
  } catch (error) {
    console.error('Error loading events:', error);
  }
}

async function start() {
  try {
    validateConfig();

    console.log('Initializing database...');
    await initDatabase();

    console.log('Loading invite count cache...');
    await initInviteCountCache();

    console.log('Loading commands...');
    await loadCommands();

    console.log('Loading events...');
    await loadEvents();

    console.log('Logging in...');
    await client.login(config.token);
  } catch (error) {
    console.error('Fatal error during startup:', error);
    process.exit(1);
  }
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

async function shutdown(signal) {
  console.log(`Received ${signal}, taking invite snapshot...`);
  try {
    if (client.isReady()) {
      const mainGuild = client.guilds.cache.get(config.mainGuildId);
      if (mainGuild) {
        await takeInviteSnapshot(mainGuild);
      }
    }
  } catch (err) {
    console.error('Shutdown snapshot error:', err);
  }
  await closeDatabase();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

let keepAliveTick = 0;

async function keepAlive() {
  const { waitForRecovery } = await import('./utils/guildState.js');
  await waitForRecovery();

  while (true) {
    try {
      if (client.isReady()) {
        const mainGuild = client.guilds.cache.get(config.mainGuildId);
        if (mainGuild) {
          keepAliveTick++;
          if (keepAliveTick % 6 === 0) {
            await syncInviteLedger(mainGuild);
          }
          if (keepAliveTick % 20 === 0) {
            await takeInviteSnapshot(mainGuild);
          }
          if (keepAliveTick % 40 === 0) {
            await cleanupStaleRegistry();
          }
        }
      }
    } catch (error) {
      console.error('Error in keepAlive:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 180000));
  }
}

start().then(() => {
  keepAlive();
});
