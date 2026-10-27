import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "#api/modules/auth/password";

describe("password security", () => {
  it("hashes passwords with Argon2id and verifies only the matching password", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");

    expect(passwordHash).toMatch(/^\$argon2id\$/);
    await expect(
      verifyPassword(passwordHash, "correct horse battery staple"),
    ).resolves.toBe(true);
    await expect(verifyPassword(passwordHash, "wrong password")).resolves.toBe(
      false,
    );
  });

  it("uses a unique random salt for every stored password", async () => {
    const password = "same password";

    const [firstHash, secondHash] = await Promise.all([
      hashPassword(password),
      hashPassword(password),
    ]);

    expect(firstHash).not.toBe(secondHash);
  });
});
