import { REST, Routes } from 'discord.js';
import config from './config.js';
import { readdir } from 'fs/promises';
import { pathToFileURL } from 'url';
import { join } from 'path';

const commands = [];
const commandsPath = join(process.cwd(), 'src', 'commands');

try {
  const commandFiles = await readdir(commandsPath);
  
  const jsFiles = commandFiles.filter((f) => f.endsWith('.js'));
  const imported = await Promise.all(
    jsFiles.map(async (file) => {
      const filePath = join(commandsPath, file);
      const fileUrl = pathToFileURL(filePath).href;
      return import(fileUrl);
    })
  );

  for (const command of imported) {
    if ('data' in command && 'execute' in command) {
      commands.push(command.data.toJSON());
      console.log(`Loaded command: ${command.data.name}`);
    }
  }

  const rest = new REST().setToken(config.token);

  console.log(`Deploying ${commands.length} commands...`);

  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.mainGuildId),
    { body: commands }
  );

  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.claimGuildId),
    { body: commands }
  );

  console.log('Successfully deployed commands to both guilds');
} catch (error) {
  console.error('Error deploying commands:', error);
  process.exit(1);
}
