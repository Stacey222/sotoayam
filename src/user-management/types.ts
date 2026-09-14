import type { Division, Role, SystemAuthorityAssignment } from "../governance/types.js";

export type UserManagementStatus = "pending" | "active" | "inactive";

export interface ManagedDivision extends Division {
  grants_system_authority?: boolean;
  provisioning_source?: "CUSTOMER" | "PRESET" | "SETUP" | null;
}

export interface ManagedUser {
  id: number;
  display_name: string | null;
  email?: string | null;
  business_user_code: string | null;
  division: ManagedDivision | null;
  role: Role | null;
  active: boolean;
  telegram_connected: boolean;
  has_login?: boolean;
  password_change_required?: boolean;
  system_admin?: boolean;
  effective_system_admin?: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminUserDto {
  id: number;
  display_name: string | null;
  email: string | null;
  business_user_code: string | null;
  division: null | { id: number; code: string; name: string; active: boolean; grants_system_authority: boolean };
  role: null | { id: number; code: string; name: string; active: boolean };
  active: boolean;
  telegram_connected: boolean;
  has_login: boolean;
  password_change_required: boolean;
  system_admin: boolean;
  effective_system_admin: boolean;
  is_current_user: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserListFilters {
  q?: string;
  status?: UserManagementStatus;
  division_id?: number;
  system_admin?: boolean;
  has_login?: boolean;
  limit: number;
  cursor_created_at?: string;
  cursor_id?: number;
}

export interface ManagedUserPage { users: ManagedUser[]; hasMore: boolean }

export interface AdministratorCredentialInput {
  displayName: string;
  email: string;
  divisionId: number;
  roleId: number;
  grantSystemAdmin: boolean;
  reason: string;
  passwordAlgorithm: "scrypt";
  passwordHash: string;
  actorUserId: number;
}

export interface LoginCredentialInput {
  userId: number;
  email: string;
  reason: string;
  passwordAlgorithm: "scrypt";
  passwordHash: string;
  actorUserId: number;
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
