export type ChannelType = "TELEGRAM";

export interface NormalizedUser {
  id: number;
  display_name: string | null;
  division_id: number | null;
  role_id: number | null;
  active: boolean;
  legacy_telegram_user_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface UserChannel {
  id: number;
  user_id: number;
  channel_type: ChannelType;
  external_id: string;
  username: string | null;
  active: boolean;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LegacyIdentitySnapshot {
  id: number;
  telegram_chat_id: number | string;
  division: string;
  role: string;
  active: boolean;
}

export interface NormalizedIdentitySnapshot {
  id: number;
  legacy_telegram_user_id: number | null;
  active: boolean;
  division_code: string | null;
  role_code: string | null;
}

export interface ChannelIdentitySnapshot {
  id: number;
  user_id: number;
  channel_type: string;
  external_id: string;
}

export interface IdentityReconciliationCounts {
  match: number;
  missingNormalized: number;
  missingLegacy: number;
  mismatch: number;
  duplicate: number;
}
