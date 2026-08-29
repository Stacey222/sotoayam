import type { SupabaseClient } from "@supabase/supabase-js";
import type { Permission } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

interface RolePermissionRow {
  permissions: Permission | Permission[] | null;
}

export interface PermissionsRepository {
  findAll(options?: { activeOnly?: boolean }): Promise<Permission[]>;
  findForRoleCode(roleCode: string): Promise<Permission[]>;
}

export class SupabasePermissionsRepository implements PermissionsRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findAll(options: { activeOnly?: boolean } = {}): Promise<Permission[]> {
    let query = this.client.from("permissions").select("*").order("code", { ascending: true });
    if (options.activeOnly) query = query.eq("active", true);
    const { data, error } = await query;
    if (error) throw governanceDatabaseError("Unable to load permissions", error);
    return (data ?? []) as Permission[];
  }

  async findForRoleCode(roleCode: string): Promise<Permission[]> {
    const { data, error } = await this.client
      .from("role_permissions")
      .select("permissions!inner(*), roles!inner(code)")
      .eq("roles.code", roleCode);
    if (error) throw governanceDatabaseError("Unable to load role permissions", error);
    return ((data ?? []) as unknown as RolePermissionRow[]).flatMap((row) => {
      if (!row.permissions) return [];
      return Array.isArray(row.permissions) ? row.permissions : [row.permissions];
    });
  }
}
