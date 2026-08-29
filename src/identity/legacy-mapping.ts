const DIVISION_CODE_BY_LEGACY_VALUE: Readonly<Record<string, string>> = {
  Purchasing: "PURCHASING",
  "Sales Grosir": "SALES_GROSIR",
  "Digital Marketing": "DIGITAL_MARKETING",
  "Content Creator": "CONTENT_CREATOR",
  "On Page / B2C": "ONPAGE_B2C",
  "Live Shopee": "SHOPEE_LIVE",
  "Shopee Live": "SHOPEE_LIVE",
  Gudang: "GUDANG",
  Management: "MANAGEMENT",
  IT: "IT",
};

const ROLE_CODE_BY_LEGACY_VALUE: Readonly<Record<string, string>> = {
  Staff: "STAFF",
  Admin: "ADMIN",
  Owner: "OWNER",
};

export function mapLegacyDivision(value: string): string | null | undefined {
  if (value === "UNASSIGNED") return null;
  return DIVISION_CODE_BY_LEGACY_VALUE[value];
}

export function mapLegacyRole(value: string): string | null | undefined {
  if (value === "UNASSIGNED") return null;
  return ROLE_CODE_BY_LEGACY_VALUE[value];
}
