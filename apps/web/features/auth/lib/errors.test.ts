import {
  loginErrorMessage,
  responseError,
} from "@web/features/auth/lib/errors";
import { describe, expect, it } from "vitest";

describe("authentication error messages", () => {
  it.each(["invalid_request", "invalid_session", "unknown_error"])(
    "shows a recoverable Google login error for %s",
    (code) => {
      expect(loginErrorMessage(code)).toBe(
        "Google 로그인 중 오류가 발생했습니다.",
      );
    },
  );

  it.each([undefined, ""])(
    "keeps an ordinary login free of errors: %s",
    (code) => {
      expect(loginErrorMessage(code)).toBeUndefined();
    },
  );

  it("uses the server's error message", async () => {
    const response = Response.json({ message: "비밀번호를 확인해주세요." });

    expect(await responseError(response)).toBe("비밀번호를 확인해주세요.");
  });

  it("falls back when the response is not valid JSON", async () => {
    const response = new Response("Service unavailable", { status: 503 });

    expect(await responseError(response)).toBe(
      "요청을 처리하지 못했습니다. 다시 시도해주세요.",
    );
  });
});
