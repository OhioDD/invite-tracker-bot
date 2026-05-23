import dotenv from 'dotenv';
dotenv.config();

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  mainGuildId: process.env.MAIN_GUILD_ID,
  claimGuildId: process.env.CLAIM_GUILD_ID,
  databaseUrl: process.env.DATABASE_URL,
  fakeInviteThresholdDays: 7,
  ollamaApiKey: process.env.OLLAMA_API_KEY,
  // Use :cloud suffix for Ollama Cloud vision models (see ollama.com/library/gemma3)
  ollamaCloudModel: process.env.OLLAMA_CLOUD_MODEL || 'gemma3:12b-cloud',
  ollamaCloudHost: 'https://ollama.com'
};

export function validateConfig() {
  const required = [
    ['DISCORD_TOKEN', config.token],
    ['CLIENT_ID', config.clientId],
    ['MAIN_GUILD_ID', config.mainGuildId],
    ['CLAIM_GUILD_ID', config.claimGuildId],
    ['DATABASE_URL', config.databaseUrl]
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export default config;
