import { AppError } from "../errors.js";

export const BUSINESS_USER_CODE_MIN_LENGTH = 3;
export const BUSINESS_USER_CODE_MAX_LENGTH = 40;
export const BUSINESS_USER_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;

export function normalizeBusinessUserCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized.length < BUSINESS_USER_CODE_MIN_LENGTH
    || normalized.length > BUSINESS_USER_CODE_MAX_LENGTH
    || !BUSINESS_USER_CODE_PATTERN.test(normalized)) {
    throw new AppError(400, "BUSINESS_USER_CODE_INVALID", "Business user code must use 3-40 uppercase letters, numbers, or hyphens and start with a letter");
  }
  return normalized;
}
