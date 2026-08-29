import type { Division, Role, SystemAuthorityAssignment } from "../governance/types.js";

export type UserManagementStatus = "pending" | "active" | "inactive";

export interface ManagedUser {
  id: number;
  display_name: string | null;
  division: Division | null;
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

export interface UserManagementCatalogs {
  divisions: Division[];
  roles: Role[];
}

export interface AuthorityResult extends SystemAuthorityAssignment {}
