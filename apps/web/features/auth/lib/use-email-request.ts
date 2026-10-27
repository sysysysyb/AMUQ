"use client";

import { postJson } from "@web/features/auth/lib/api";
import { responseError } from "@web/features/auth/lib/errors";
import { formatKoreanTime } from "@web/features/auth/lib/format-korean-time";
import { useEffect, useState } from "react";

interface EmailRequestLimit {
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export const useEmailRequest = (endpoint: string) => {
  const [pending, setPending] = useState(false);
  const [rateLimit, setRateLimit] = useState<EmailRequestLimit>();
  const [retryUntil, setRetryUntil] = useState<number>();
  const [error, setError] = useState<string>();
  const [completed, setCompleted] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!retryUntil) return;
    const timer = window.setTimeout(
      () => {
        setRetryUntil(undefined);
        setRateLimit(undefined);
        setCompleted(false);
      },
      Math.max(0, retryUntil - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [retryUntil]);

  const send = async (email: string) => {
    if (pending || retryUntil) return false;
    setPending(true);
    setCompleted(false);
    try {
      const response = await postJson(endpoint, { email });
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        setRetryUntil(
          Date.now() +
            (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1_000,
        );
        setError(undefined);
        return false;
      }
      if (!response.ok) {
        setError(await responseError(response));
        return false;
      }
      const result = (await response.json()) as {
        rateLimit?: EmailRequestLimit;
      };
      setRateLimit(result.rateLimit);
      if (result.rateLimit?.remaining === 0) {
        setRetryUntil(Date.now() + result.rateLimit.retryAfterSeconds * 1_000);
      }
      setError(undefined);
      setCompleted(true);
      return true;
    } catch {
      setError("메일 요청에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.");
      return false;
    } finally {
      setPending(false);
      setVersion((value) => value + 1);
    }
  };

  return {
    send,
    pending,
    rateLimit,
    error,
    completed,
    version,
    retryAt: retryUntil ? formatKoreanTime(new Date(retryUntil)) : undefined,
  };
};
