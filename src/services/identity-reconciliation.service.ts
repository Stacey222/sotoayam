import { mapLegacyDivision, mapLegacyRole } from "../identity/legacy-mapping.js";
import type {
  ChannelIdentitySnapshot,
  IdentityReconciliationCounts,
  LegacyIdentitySnapshot,
  NormalizedIdentitySnapshot,
} from "../identity/types.js";

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    groups.set(value, [...(groups.get(value) ?? []), item]);
  }
  return groups;
}

export function reconcileIdentitySnapshots(
  legacyUsers: readonly LegacyIdentitySnapshot[],
  normalizedUsers: readonly NormalizedIdentitySnapshot[],
  channels: readonly ChannelIdentitySnapshot[],
): IdentityReconciliationCounts {
  const normalizedByLegacy = groupBy(
    normalizedUsers.filter((user) => user.legacy_telegram_user_id !== null),
    (user) => String(user.legacy_telegram_user_id),
  );
  const telegramChannels = channels.filter((channel) => channel.channel_type === "TELEGRAM");
  const channelsByExternalId = groupBy(telegramChannels, (channel) => channel.external_id);
  const legacyIds = new Set(legacyUsers.map((user) => String(user.id)));
  const legacyExternalIds = new Set(legacyUsers.map((user) => String(user.telegram_chat_id)));
  const duplicateKeys = new Set<string>();

  for (const [legacyId, users] of normalizedByLegacy) {
    if (users.length > 1) duplicateKeys.add(`legacy:${legacyId}`);
  }
  for (const [externalId, matchingChannels] of channelsByExternalId) {
    if (matchingChannels.length > 1) duplicateKeys.add(`telegram:${externalId}`);
  }

  let match = 0;
  let missingNormalized = 0;
  let mismatch = 0;

  for (const legacy of legacyUsers) {
    const normalizedMatches = normalizedByLegacy.get(String(legacy.id)) ?? [];
    const channelMatches = channelsByExternalId.get(String(legacy.telegram_chat_id)) ?? [];
    if (normalizedMatches.length > 1 || channelMatches.length > 1) continue;
    const normalized = normalizedMatches[0];
    const channel = channelMatches[0];
    if (!normalized || !channel) {
      missingNormalized += 1;
      continue;
    }

    const expectedDivision = mapLegacyDivision(legacy.division);
    const expectedRole = mapLegacyRole(legacy.role);
    const attributesMatch = expectedDivision !== undefined
      && expectedRole !== undefined
      && normalized.active === legacy.active
      && normalized.division_code === expectedDivision
      && normalized.role_code === expectedRole
      && channel.user_id === normalized.id;
    if (attributesMatch) match += 1;
    else mismatch += 1;
  }

  const missingLegacyKeys = new Set<string>();
  for (const normalized of normalizedUsers) {
    if (normalized.legacy_telegram_user_id !== null && !legacyIds.has(String(normalized.legacy_telegram_user_id))) {
      missingLegacyKeys.add(`user:${normalized.id}`);
    }
  }
  for (const channel of telegramChannels) {
    if (!legacyExternalIds.has(channel.external_id)) missingLegacyKeys.add(`channel:${channel.id}`);
  }

  return {
    match,
    missingNormalized,
    missingLegacy: missingLegacyKeys.size,
    mismatch,
    duplicate: duplicateKeys.size,
  };
}
