export interface SystemAdminCapabilitySubject {
  active: boolean;
  divisionId: number | null;
  roleId: number | null;
  divisionGrantsSystemAuthority?: boolean;
}

export function hasSystemAdminCapability(subject: SystemAdminCapabilitySubject): boolean {
  return subject.active
    && subject.divisionId !== null
    && subject.roleId !== null
    && subject.divisionGrantsSystemAuthority === true;
}

