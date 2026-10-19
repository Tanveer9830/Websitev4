import crypto from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt (N=16384, r=8, p=1, 64 bytes).
 * Storage format: scrypt$<N>$<r>$<p>$<salt hex>$<hash hex>
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keyLen, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, nStr, rStr, pStr, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const params = { N: Number(nStr), r: Number(rStr), p: Number(pStr), keyLen: Number(hashHex.length) / 2 };
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, params);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Validate a candidate password against our policy (min 10 chars, letter + digit). */
export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters long.';
  if (password.length > 200) return 'Password must be at most 200 characters long.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number.';
  }
  return null;
}

export function generateRandomPassword(length = 24): string {
  // Unambiguous base64url-ish alphabet, 1 char ~ 6 bits; 24 chars = 144 bits.
  return crypto.randomBytes(length).toString('base64url').replace(/[-_]/g, (c) => (c === '-' ? 'x' : 'y')).slice(0, length);
}
