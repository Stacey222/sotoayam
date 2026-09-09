import type { SupabaseClient } from "@supabase/supabase-js";
import type { InstallationLineage, InstallationProvenance } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface InstallationProvenanceRepository {
  getLineage(): Promise<InstallationLineage>;
}

export class SupabaseInstallationProvenanceRepository implements InstallationProvenanceRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getLineage(): Promise<InstallationLineage> {
    const { data, error } = await this.client.from("installation_provenance").select("lineage").limit(1).maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load installation provenance", error);
    return data ? (data as Pick<InstallationProvenance, "lineage">).lineage : "UNKNOWN";
  }
}

