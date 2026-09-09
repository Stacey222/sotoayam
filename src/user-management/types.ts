import type { Division, Role, SystemAuthorityAssignment } from "../governance/types.js";

export type UserManagementStatus = "pending" | "active" | "inactive";

export interface ManagedDivision extends Division {
  grants_system_authority?: boolean;
  provisioning_source?: "CUSTOMER" | "PRESET" | "SETUP" | null;
}

export interface ManagedUser {
  id: number;
  display_name: string | null;
  business_user_code: string | null;
  division: ManagedDivision | null;
  role: Role | null;
  active: boolean;
  telegram_connected: boolean;
  created_at: string;
  updated_at: string;
}

export interface AccessUpdate {
  division_id: number | null;
  role_id: number | null;
  active: boolean;
}

export interface BusinessUserCodeUpdate {
  business_user_code: string | null;
  confirm_change: boolean;
}

export interface UserManagementCatalogs {
  divisions: Division[];
  roles: Role[];
}

export interface AuthorityResult extends SystemAuthorityAssignment {}
