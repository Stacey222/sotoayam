export const ROLE_SEEDS = ["STAFF", "ADMIN", "OWNER"] as const;

export const OPERATIONAL_PERMISSIONS = [
  "task.view_assigned",
  "task.create",
  "task.update_assigned",
  "task.complete_assigned",
  "task.add_activity",
  "task.import",
  "task.view_division",
  "report.view_division",
  "alert.view_division",
  "report.view_cross_division",
  "alert.view_critical",
  "alert.acknowledge",
  "approval.view",
  "approval.decide",
  "automation_status.view_business",
] as const;

export const GOVERNANCE_PERMISSIONS = [
  "user.manage",
  "division.manage",
  "role.manage",
  "permission.manage",
  "routing.manage",
  "threshold.manage",
  "collaboration_rule.manage",
  "system_authority.manage",
  "technical_monitoring.view",
] as const;

export const ROLE_PERMISSION_SEEDS = {
  STAFF: [
    "task.view_assigned",
    "task.create",
    "task.update_assigned",
    "task.complete_assigned",
    "task.add_activity",
    "task.import",
  ],
  ADMIN: [
    "task.view_assigned",
    "task.create",
    "task.update_assigned",
    "task.complete_assigned",
    "task.add_activity",
    "task.import",
    "task.view_division",
    "report.view_division",
    "alert.view_division",
  ],
  OWNER: [
    "report.view_cross_division",
    "alert.view_critical",
    "alert.acknowledge",
    "approval.view",
    "approval.decide",
    "automation_status.view_business",
  ],
} as const;

export const PERMISSION_SEEDS = [
  ...OPERATIONAL_PERMISSIONS,
  ...GOVERNANCE_PERMISSIONS,
] as const;
