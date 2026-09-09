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
