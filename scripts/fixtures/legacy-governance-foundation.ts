// Internal contract fixture mirroring the immutable origin seed migration.
// This is not runtime provisioning data and must never become a fresh-install default.
export const LEGACY_DIVISION_SEEDS = [
  { code: "PURCHASING", name: "Purchasing" },
  { code: "SALES_GROSIR", name: "Sales Grosir" },
  { code: "DIGITAL_MARKETING", name: "Digital Marketing" },
  { code: "CONTENT_CREATOR", name: "Content Creator" },
  { code: "ONPAGE_B2C", name: "On Page / B2C" },
  { code: "SHOPEE_LIVE", name: "Shopee Live" },
  { code: "GUDANG", name: "Gudang" },
  { code: "MANAGEMENT", name: "Management" },
  { code: "IT", name: "IT" },
] as const;

export const FOUNDATION_PERMISSION_SEEDS = [
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
  "approval.view",
  "approval.decide",
  "automation_status.view_business",
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

export const FOUNDATION_ROLE_PERMISSION_SEEDS = {
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
    "approval.view",
    "approval.decide",
    "automation_status.view_business",
  ],
} as const;
