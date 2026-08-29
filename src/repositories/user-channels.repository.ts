import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelType, UserChannel } from "../identity/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface UserChannelsRepository {
  findByExternalIdentity(channelType: ChannelType, externalId: string): Promise<UserChannel | null>;
}

export class SupabaseUserChannelsRepository implements UserChannelsRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findByExternalIdentity(channelType: ChannelType, externalId: string): Promise<UserChannel | null> {
    const { data, error } = await this.client
      .from("user_channels")
      .select("*")
      .eq("channel_type", channelType)
      .eq("external_id", externalId)
      .maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load user channel", error);
    return data as UserChannel | null;
  }
}
