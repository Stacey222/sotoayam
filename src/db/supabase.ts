import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseConfig } from "../config/env.js";

export function createSupabaseClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
