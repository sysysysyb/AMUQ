import { expect, it } from "vitest";

import { migrateDatabase } from "#api/db/migrations";
import {
  authenticateSession,
  issueSession,
  revokeSession,
  rotateSession,
} from "#api/modules/auth/service";
import { hashOpaqueToken } from "#api/modules/auth/token";
import { setupAuthDatabase } from "#api-test/support/auth-database";

const { admin, connectionString, databaseTest } = setupAuthDatabase();

databaseTest("authentication sessions database", () => {
  it("validates, revokes, and rotates stored sessions", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('session-user@example.com') RETURNING id::text",
    );
    const userId = user.rows[0]!.id;
    const start = new Date("2026-09-01T00:00:00.000Z");

    await expect(issueSession(admin!, userId, start)).resolves.toBeUndefined();
    await admin!.query(
      "UPDATE users SET email_verified_at = $2 WHERE id = $1",
      [userId, start],
    );

    const idleExpiredToken = await issueSession(admin!, userId, start);
    await expect(
      authenticateSession(
        admin!,
        idleExpiredToken!,
        new Date("2026-09-08T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();

    const absoluteExpiredToken = await issueSession(admin!, userId, start);
    for (const day of [6, 12, 18, 24, 29]) {
      await expect(
        authenticateSession(
          admin!,
          absoluteExpiredToken!,
          new Date(start.getTime() + day * 24 * 60 * 60 * 1_000),
        ),
      ).resolves.toBe(userId);
    }
    await expect(
      authenticateSession(
        admin!,
        absoluteExpiredToken!,
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();

    const rotationBoundaryToken = await issueSession(admin!, userId, start);
    for (const day of [6, 12, 18, 24]) {
      await authenticateSession(
        admin!,
        rotationBoundaryToken!,
        new Date(start.getTime() + day * 24 * 60 * 60 * 1_000),
      );
    }
    const rotationAtDayTwentyNine = await rotateSession(
      admin!,
      rotationBoundaryToken!,
      new Date("2026-09-30T00:00:00.000Z"),
    );
    expect(rotationAtDayTwentyNine).toBeDefined();
    await expect(
      authenticateSession(
        admin!,
        rotationAtDayTwentyNine!,
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();

    const rawToken = await issueSession(admin!, userId, start);
    const stored = await admin!.query<{ tokenHash: string }>(
      'SELECT token_hash AS "tokenHash" FROM auth_sessions WHERE token_hash = $1',
      [hashOpaqueToken(rawToken!)],
    );
    expect(stored.rows).toEqual([{ tokenHash: hashOpaqueToken(rawToken!) }]);
    expect(stored.rows[0]!.tokenHash).not.toBe(rawToken);

    const daySix = new Date("2026-09-07T00:00:00.000Z");
    await expect(authenticateSession(admin!, rawToken!, daySix)).resolves.toBe(
      userId,
    );
    const refreshed = await admin!.query<{
      idleExpiresAt: Date;
      lastSeenAt: Date;
    }>(
      'SELECT idle_expires_at AS "idleExpiresAt", last_seen_at AS "lastSeenAt" FROM auth_sessions WHERE token_hash = $1',
      [hashOpaqueToken(rawToken!)],
    );
    expect(refreshed.rows).toEqual([
      {
        idleExpiresAt: new Date("2026-09-14T00:00:00.000Z"),
        lastSeenAt: daySix,
      },
    ]);

    await expect(
      authenticateSession(
        admin!,
        rawToken!,
        new Date("2026-09-06T00:00:00.000Z"),
      ),
    ).resolves.toBe(userId);
    const afterOlderRequest = await admin!.query<{
      idleExpiresAt: Date;
      lastSeenAt: Date;
    }>(
      'SELECT idle_expires_at AS "idleExpiresAt", last_seen_at AS "lastSeenAt" FROM auth_sessions WHERE token_hash = $1',
      [hashOpaqueToken(rawToken!)],
    );
    expect(afterOlderRequest.rows).toEqual(refreshed.rows);

    const rotatedToken = await rotateSession(
      admin!,
      rawToken!,
      new Date("2026-09-08T00:00:00.000Z"),
    );
    expect(rotatedToken).toBeDefined();
    await expect(
      authenticateSession(
        admin!,
        rawToken!,
        new Date("2026-09-08T00:01:00.000Z"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      authenticateSession(
        admin!,
        rotatedToken!,
        new Date("2026-09-08T00:01:00.000Z"),
      ),
    ).resolves.toBe(userId);

    await revokeSession(
      admin!,
      rotatedToken!,
      new Date("2026-09-08T00:02:00.000Z"),
    );
    await expect(
      authenticateSession(
        admin!,
        rotatedToken!,
        new Date("2026-09-08T00:03:00.000Z"),
      ),
    ).resolves.toBeUndefined();
  });
});
