import type { ManagedUser, UserManagementStatus } from "../user-management/types.js";

export const telegramItMessages = {
  title: "Sotoayam IT Console",
  menu: { userManagement: "User Management", systemStatus: "System Status", collaborationRules: "Collaboration Rules" },
  buttons: { pendingUsers: "Pending Users", activeUsers: "Active Users", inactiveUsers: "Inactive Users",
    viewRules: "View Rules", assignDivision: "Assign Division", assignRole: "Assign Role", businessUserCode: "Business User Code",
    deactivate: "Deactivate", activate: "Activate" },
  systemStatus: "System Status\n\nRuntime: Aktif\nUser Management: Tersedia",
  noRules: "Collaboration Rules\n\nTidak ada rule.",
  noUsers: "Tidak ada user.",
  userDetail: "User Detail",
  unnamedUser: "User tanpa nama",
  businessCodeCancelled: "Perubahan business user code dibatalkan.",
  businessCodeUpdated: "Business user code berhasil diperbarui.",
  businessCodeInputHelp: "Kirim kode yang valid, NONE untuk menghapus, atau /cancel.",
  businessCodePromptSuffix: "Kirim kode baru (3-40 karakter, huruf/angka/hyphen, diawali huruf). Kirim NONE untuk menghapus atau /cancel.",
  codeChangeWarning: "Perubahan kode yang sudah ada dapat memengaruhi integrasi.",
  catalogPrompt: "Pilih dari katalog aktif:",
  changeConfirmation: "Konfirmasi Perubahan",
  newDivision: "New Division",
  newRole: "New Role",
  activationUnavailable: "User belum dapat diaktifkan. Tetapkan Divisi dan Role terlebih dahulu.",
  selfDeactivationForbidden: "Akun administrator yang sedang digunakan tidak dapat menonaktifkan dirinya sendiri.",
  lastSystemAdmin: "User ini tidak dapat dinonaktifkan karena merupakan SYSTEM_ADMIN aktif terakhir.",
} as const;

export const safeUserName = (user: Pick<ManagedUser, "display_name">): string => user.display_name?.trim() || telegramItMessages.unnamedUser;
export const userListTitle = (status: UserManagementStatus): string => status === "pending"
  ? telegramItMessages.buttons.pendingUsers : status === "active" ? telegramItMessages.buttons.activeUsers : telegramItMessages.buttons.inactiveUsers;
export function formatBusinessCodeConfirmation(value: string | null): string {
  return `Konfirmasi Business User Code\n\nNilai baru: ${value ?? "Belum ditetapkan"}\n\n${telegramItMessages.codeChangeWarning}`;
}
export function formatBusinessCodePrompt(user: ManagedUser): string {
  return `Business User Code\n\nUser: ${safeUserName(user)}\nCurrent: ${user.business_user_code ?? "Belum ditetapkan"}\n\n${telegramItMessages.businessCodePromptSuffix}`;
}
export function formatUserSummary(user: ManagedUser, index: number): string {
  return `${index}. ${safeUserName(user)}\nDivision: ${user.division?.code ?? "Belum ditetapkan"}\nRole: ${user.role?.code ?? "Belum ditetapkan"}\nStatus: ${user.active ? "Aktif" : "Tidak aktif"}\nTelegram Connected: ${user.telegram_connected ? "Yes" : "No"}`;
}
export function formatUserDetail(user: ManagedUser): string {
  return `Name: ${safeUserName(user)}\nBusiness User Code: ${user.business_user_code ?? "Belum ditetapkan"}\nTelegram Connected: ${user.telegram_connected ? "Yes" : "No"}\nDivision: ${user.division?.code ?? "Belum ditetapkan"}\nRole: ${user.role?.code ?? "Belum ditetapkan"}\nStatus: ${user.active ? "Aktif" : "Tidak aktif"}`;
}
export function formatCollaborationRules(rules: readonly { source: string; target: string; allowed: boolean;
  requiresApproval: boolean; active: boolean }[]): string {
  return rules.length === 0 ? telegramItMessages.noRules : `Collaboration Rules\n\n${rules.map((rule) =>
    `${rule.source} \u2192 ${rule.target}\nAllowed: ${rule.allowed ? "Yes" : "No"}\nApproval: ${rule.requiresApproval ? "Required" : "No"}\nStatus: ${rule.active ? "Active" : "Inactive"}`).join("\n\n")}`;
}
export function formatUserList(status: UserManagementStatus, summaries: readonly string[], page: number, pages: number): string {
  const title = userListTitle(status);
  return summaries.length === 0 ? `${title}\n\n${telegramItMessages.noUsers}`
    : `${title}\n\n${summaries.join("\n\n")}\n\nHalaman ${page + 1}/${pages}`;
}
export const formatUserDetailResponse = (detail: string, notice?: string): string =>
  `${notice ? `${notice}\n\n` : ""}${telegramItMessages.userDetail}\n\n${detail}`;
export function formatCatalogPrompt(kind: string, userName: string): string {
  return `${kind === "d" ? telegramItMessages.buttons.assignDivision : telegramItMessages.buttons.assignRole}\n\nUser: ${userName}\n${telegramItMessages.catalogPrompt}`;
}
export function formatAssignmentPreview(kind: string, userName: string, code: string): string {
  return `${telegramItMessages.changeConfirmation}\n\nUser: ${userName}\n${kind === "d" ? telegramItMessages.newDivision : telegramItMessages.newRole}: ${code}`;
}
export function formatActivePreview(active: boolean, user: ManagedUser): string {
  const verb = active ? telegramItMessages.buttons.activate : telegramItMessages.buttons.deactivate;
  return `${verb} user?\n\nUser: ${safeUserName(user)}\nDivision: ${user.division?.code ?? "Belum ditetapkan"}\nRole: ${user.role?.code ?? "Belum ditetapkan"}`;
}
export const formatUserActiveNotice = (active: boolean): string => `User berhasil ${active ? "diaktifkan" : "dinonaktifkan"}.`;
export const formatAssignmentUpdated = (kind: string): string => `${kind === "d" ? "Division" : "Role"} berhasil diperbarui.`;
