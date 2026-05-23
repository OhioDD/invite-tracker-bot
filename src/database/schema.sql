CREATE TABLE IF NOT EXISTS invites (
  id SERIAL PRIMARY KEY,
  inviter_id VARCHAR(20) NOT NULL,
  invitee_id VARCHAR(20) NOT NULL,
  guild_id VARCHAR(20) NOT NULL,
  invite_code VARCHAR(50),
  joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
  left_at TIMESTAMP,
  is_fake BOOLEAN DEFAULT FALSE,
  is_left BOOLEAN DEFAULT FALSE
);

CREATE UNIQUE INDEX idx_invites_guild_invitee ON invites(guild_id, invitee_id);
CREATE INDEX idx_invites_inviter ON invites(inviter_id, guild_id);
CREATE INDEX idx_invites_invitee ON invites(invitee_id, guild_id);
CREATE INDEX idx_invites_composite ON invites(inviter_id, guild_id, is_fake, is_left);

CREATE TABLE IF NOT EXISTS invite_registry (
  guild_id VARCHAR(20) NOT NULL,
  code VARCHAR(50) NOT NULL,
  inviter_id VARCHAR(20) NOT NULL,
  is_vanity BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (guild_id, code)
);

CREATE INDEX idx_registry_inviter ON invite_registry(guild_id, inviter_id);

CREATE TABLE IF NOT EXISTS invite_use_snapshots (
  id SERIAL PRIMARY KEY,
  guild_id VARCHAR(20) NOT NULL,
  code VARCHAR(50) NOT NULL,
  inviter_id VARCHAR(20),
  uses INTEGER NOT NULL,
  is_vanity BOOLEAN DEFAULT FALSE,
  taken_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_snapshots_guild_time ON invite_use_snapshots(guild_id, taken_at DESC);
CREATE INDEX idx_snapshots_guild_code ON invite_use_snapshots(guild_id, code);

CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  channel_id VARCHAR(64) NOT NULL UNIQUE,
  user_id VARCHAR(20) NOT NULL,
  guild_id VARCHAR(20) NOT NULL,
  status VARCHAR(20) DEFAULT 'open',
  claimed_count INTEGER,
  actual_count INTEGER,
  verification_note TEXT,
  proof_anchor_message_id VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP
);

CREATE INDEX idx_tickets_user ON tickets(user_id, guild_id);
CREATE INDEX idx_tickets_channel ON tickets(channel_id);

CREATE UNIQUE INDEX idx_tickets_one_active_per_user
  ON tickets(user_id, guild_id)
  WHERE status NOT IN ('closed', 'rejected');

CREATE TABLE IF NOT EXISTS guild_config (
  guild_id VARCHAR(20) NOT NULL,
  config_key VARCHAR(50) NOT NULL,
  config_value TEXT,
  PRIMARY KEY (guild_id, config_key)
);
