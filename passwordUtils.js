import bcrypt from "bcryptjs";

// bcrypt hashes always start with "$2" (e.g. $2a$, $2b$). Anything else is
// treated as a legacy plaintext password from before hashing was added.
export function isHashed(value) {
  return typeof value === "string" && value.startsWith("$2");
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

// Returns true if `plain` matches `stored`, whether `stored` is a bcrypt
// hash or a legacy plaintext password.
export async function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (isHashed(stored)) {
    return bcrypt.compare(plain, stored);
  }
  return plain === stored;
}
