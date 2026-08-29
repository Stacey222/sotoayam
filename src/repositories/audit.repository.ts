import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeAuditState } from "../governance/audit-sanitizer.js";
import type { AuditLog, AuditLogInput } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface AuditRepository {
  append(input: AuditLogInput): Promise<AuditLog>;
}

export class SupabaseAuditRepository implements AuditRepository {
  constructor(private readonly client: SupabaseClient) {}

  async append(input: AuditLogInput): Promise<AuditLog> {
    const record = {
      ...input,
      actor_user_id: input.actor_user_id ?? null,
      before_state: sanitizeAuditState(input.before_state),
      after_state: sanitizeAuditState(input.after_state),
    };
    const { data, error } = await this.client.from("audit_logs").insert(record).select("*").single();
    if (error) throw governanceDatabaseError("Unable to append audit log", error);
    return data as AuditLog;
  }
}
