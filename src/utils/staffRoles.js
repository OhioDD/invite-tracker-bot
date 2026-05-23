import { getGuildConfig, setGuildConfig } from '../database/db.js';

const CONFIG_KEY = 'staff_role_ids';
const LEGACY_KEY = 'staff_role_id';

/** Gets staff role IDs from guild config, with legacy key migration. */
export async function getStaffRoleIds(guildId) {
  const raw = await getGuildConfig(guildId, CONFIG_KEY);
  if (raw) {
    return raw.split(',').map((id) => id.trim()).filter(Boolean);
  }

  const legacy = await getGuildConfig(guildId, LEGACY_KEY);
  if (legacy) {
    await setGuildConfig(guildId, CONFIG_KEY, legacy);
    return [legacy];
  }

  return [];
}

/** Adds a staff role ID, returns whether it was newly added. */
export async function addStaffRole(guildId, roleId) {
  const ids = await getStaffRoleIds(guildId);
  if (ids.includes(roleId)) {
    return { added: false, ids };
  }
  ids.push(roleId);
  await setGuildConfig(guildId, CONFIG_KEY, ids.join(','));
  return { added: true, ids };
}

/** Removes a staff role ID, returns remaining role IDs. */
export async function removeStaffRole(guildId, roleId) {
  const ids = (await getStaffRoleIds(guildId)).filter((id) => id !== roleId);
  await setGuildConfig(guildId, CONFIG_KEY, ids.join(','));
  return ids;
}

/** Checks if a guild member has any of the staff roles. */
export function memberIsStaff(member, roleIds) {
  if (!member || roleIds.length === 0) return false;
  return roleIds.some((id) => member.roles.cache.has(id));
}

/** Builds a role mention string from an array of role IDs. */
export function staffMentionString(roleIds) {
  return roleIds.map((id) => `<@&${id}>`).join(' ');
}


