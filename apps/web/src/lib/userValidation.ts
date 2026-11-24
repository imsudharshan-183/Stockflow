export const USER_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_USER_PASSWORD_LENGTH = 8;

export function isValidUserEmail(value: string): boolean {
  return USER_EMAIL_REGEX.test(value.trim());
}

/**
 * Generates an initial strong password meeting the 8+ character policy and
 * mixing uppercase, lowercase, digits, and punctuation for admin provisioning.
 */
export function generateSecurePassword(length = 14): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*";
  const all = upper + lower + digits + symbols;

  const targetLen = Math.max(MIN_USER_PASSWORD_LENGTH, length);
  const chars = [
    upper[Math.floor(Math.random() * upper.length)]!,
    lower[Math.floor(Math.random() * lower.length)]!,
    digits[Math.floor(Math.random() * digits.length)]!,
    symbols[Math.floor(Math.random() * symbols.length)]!,
  ];
  while (chars.length < targetLen) {
    chars.push(all[Math.floor(Math.random() * all.length)]!);
  }
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }
  return chars.join("");
}
