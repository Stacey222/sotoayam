export type UserAccessStatus = "PENDING" | "ACTIVE";

export interface UserAccessSnapshot {
  active: boolean;
  divisionId: number | null;
  roleId: number | null;
  divisionCode: string | null;
  roleCode: string | null;
}

export interface UserAccessState extends UserAccessSnapshot {
  status: UserAccessStatus;
}

export function resolveUserAccessState(snapshot: UserAccessSnapshot): UserAccessState {
  return {
    ...snapshot,
    status: snapshot.active && snapshot.divisionId !== null && snapshot.roleId !== null
      ? "ACTIVE"
      : "PENDING",
  };
}
