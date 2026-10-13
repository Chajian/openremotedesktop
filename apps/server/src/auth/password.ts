import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

const KEY_LENGTH = 32;
const SCRYPT_OPTIONS: ScryptOptions = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return [
    "scrypt",
    String(SCRYPT_OPTIONS.N),
    String(SCRYPT_OPTIONS.r),
    String(SCRYPT_OPTIONS.p),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, keyRaw] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    !nRaw ||
    !rRaw ||
    !pRaw ||
    !saltRaw ||
    !keyRaw
  ) {
    return false;
  }

  const options = {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw),
  };
  if (
    !Number.isInteger(options.N) ||
    !Number.isInteger(options.r) ||
    !Number.isInteger(options.p) ||
    options.N < 2 ||
    options.r < 1 ||
    options.p < 1
  ) {
    return false;
  }

  const salt = Buffer.from(saltRaw, "base64url");
  const expected = Buffer.from(keyRaw, "base64url");
  if (expected.length !== KEY_LENGTH) return false;

  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      expected.length,
      { ...options, maxmem: SCRYPT_OPTIONS.maxmem },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey as Buffer);
      },
    );
  });

  return timingSafeEqual(actual, expected);
}
