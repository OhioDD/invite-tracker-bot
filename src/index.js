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

/** Loads all command files from the commands directory into the client. */
async function loadCommands() {
  try {
    const commandsPath = join(process.cwd(), 'src', 'commands');
    const commandFiles = (await readdir(commandsPath)).filter((f) => f.endsWith('.js'));
    const imported = await Promise.all(
      commandFiles.map(async (file) => {
        const filePath = join(commandsPath, file);
        const fileUrl = pathToFileURL(filePath).href;
        return { module: await import(fileUrl) };
      })
    );

    for (const { module: command } of imported) {
      if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        console.log(`Loaded command: ${command.data.name}`);
      }
    }
  } catch (error) {
    console.error('Error loading commands:', error);
  }
}

/** Loads all event files from the events directory into the client. */
async function loadEvents() {
  try {
    const eventsPath = join(process.cwd(), 'src', 'events');
    const eventFiles = (await readdir(eventsPath)).filter((f) => f.endsWith('.js'));
    const imported = await Promise.all(
      eventFiles.map(async (file) => {
        const filePath = join(eventsPath, file);
        const fileUrl = pathToFileURL(filePath).href;
        return await import(fileUrl);
      })
    );

    for (const event of imported) {
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

/** Starts the bot — validates config, inits DB, loads commands/events, logs in. */
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

/** Graceful shutdown — takes invite snapshot and closes DB connection. */
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
let keepAliveTimer = null;

/** Periodic keepalive loop — syncs invites, takes snapshots, cleans up stale registry. */
async function keepAlive() {
  const { waitForRecovery } = await import('./utils/guildState.js');
  await waitForRecovery();

  /** Periodic keepalive tick — syncs invites, takes snapshots, cleans up stale registry entries. */
  const tick = async () => {
    try {
      if (client.isReady()) {
        const mainGuild = client.guilds.cache.get(config.mainGuildId);
        if (mainGuild) {
          keepAliveTick += 1;
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
  };

  tick();
  keepAliveTimer = setInterval(tick, 180000);
}

start().then(() => keepAlive()).catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
