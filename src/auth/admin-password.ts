import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

const COMMON_BASES = [
  "password", "admin", "administrator", "qwerty", "letmein", "welcome", "monkey", "dragon",
  "football", "baseball", "sunshine", "princess", "iloveyou", "trustnoone", "superman",
  "whatever", "freedom", "computer", "internet", "security", "changeme", "default",
  "secret", "company", "business", "manager", "root", "master", "access", "login",
];
const COMMON_SUFFIXES = ["", "1", "12", "123", "1234", "12345", "123456", "2024", "2025", "2026"];
const COMMON_PASSWORDS = new Set(COMMON_BASES.flatMap((base) => COMMON_SUFFIXES.map((suffix) => `${base}${suffix}`)));

function deriveKey(password: Buffer, salt: Buffer, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export interface PasswordPolicyContext {
  email: string;
  displayName: string;
}

export function validatePasswordPolicy(password: string, context: PasswordPolicyContext): void {
  if (password.length < 12 || password.length > 256 || /^\s+$/.test(password) || /[\p{Cc}]/u.test(password)) {
    throw new Error("WEAK_PASSWORD");
  }

  const foldedPassword = password.toLocaleLowerCase("en-US");
  const emailLocalPart = context.email.split("@", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";
  const displayName = context.displayName.trim().toLocaleLowerCase("en-US");
  if ((emailLocalPart && foldedPassword.includes(emailLocalPart))
    || (displayName && foldedPassword.includes(displayName))
    || COMMON_PASSWORDS.has(foldedPassword)) {
    throw new Error("WEAK_PASSWORD");
  }
}

export async function hashPassword(plaintext: string | Uint8Array): Promise<string> {
  const password = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  try {
    const derivedKey = await deriveKey(password, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    });
    try {
      return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString("base64")}$${derivedKey.toString("base64")}`;
    } finally {
      derivedKey.fill(0);
    }
  } finally {
    password.fill(0);
    salt.fill(0);
  }
}

export async function verifyPassword(plaintext: string | Uint8Array, encoded: string): Promise<boolean> {
  const match = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(encoded);
  if (!match) return false;
  const password = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
  const salt = Buffer.from(match[4]!, "base64");
  const expected = Buffer.from(match[5]!, "base64");
  try {
    const actual = await deriveKey(password, salt, expected.length, {
      N: Number(match[1]), r: Number(match[2]), p: Number(match[3]), maxmem: SCRYPT_MAX_MEMORY,
    });
    try {
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } finally {
      actual.fill(0);
    }
  } catch {
    return false;
  } finally {
    password.fill(0);
    salt.fill(0);
    expected.fill(0);
  }
}
