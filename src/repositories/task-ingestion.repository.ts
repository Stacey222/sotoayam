import type { SupabaseClient } from "@supabase/supabase-js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface TaskSourceIntegration {
  id: number; code: string; name: string; source: "AUTOMATION" | "ERP";
  requesting_division_id: number; active: boolean;
}

export interface NewImportBatch {
  context: "HUMAN_IMPORT" | "INTERNAL_AUTOMATION" | "ERP_ADAPTER";
  source: "CSV_IMPORT" | "AUTOMATION" | "ERP";
  initiated_by_user_id: number | null;
  integration_id: number | null;
  safe_label: string | null;
  dry_run: boolean;
}

export interface ImportBatchRepository {
  create(input: NewImportBatch): Promise<{ id: number }>;
  complete(id: number, input: { status: "COMPLETED" | "PARTIAL" | "FAILED"; total_rows: number; created_rows: number; failed_rows: number }): Promise<void>;
}

export interface TaskSourceIntegrationsRepository {
  findActiveByCode(code: string): Promise<TaskSourceIntegration | null>;
}

export class SupabaseImportBatchRepository implements ImportBatchRepository {
  constructor(private readonly client: SupabaseClient) {}
  async create(input: NewImportBatch): Promise<{ id: number }> {
    const { data, error } = await this.client.from("task_import_batches").insert(input).select("id").single();
    if (error) throw governanceDatabaseError("Unable to create task import batch", error);
    return { id: Number(data.id) };
  }
  async complete(id: number, input: { status: "COMPLETED" | "PARTIAL" | "FAILED"; total_rows: number; created_rows: number; failed_rows: number }): Promise<void> {
    const { error } = await this.client.from("task_import_batches").update({ ...input, completed_at: new Date().toISOString() }).eq("id", id);
    if (error) throw governanceDatabaseError("Unable to complete task import batch", error);
  }
}

export class SupabaseTaskSourceIntegrationsRepository implements TaskSourceIntegrationsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async findActiveByCode(code: string): Promise<TaskSourceIntegration | null> {
    const { data, error } = await this.client.from("task_source_integrations").select("id,code,name,source,requesting_division_id,active")
      .eq("code", code).eq("active", true).maybeSingle();
    if (error) throw governanceDatabaseError("Unable to resolve task source integration", error);
    return data as TaskSourceIntegration | null;
  }
}
