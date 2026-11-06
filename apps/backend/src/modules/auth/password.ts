import { argon2id, hash, verify } from "argon2";

export const hashPassword = (password: string): Promise<string> => {
  return hash(password, { type: argon2id });
};

export const verifyPassword = (
  passwordHash: string,
  password: string,
): Promise<boolean> => {
  return verify(passwordHash, password);
};
