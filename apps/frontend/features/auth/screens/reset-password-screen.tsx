"use client";

import { ButtonLink } from "@frontend/components/ui/button";
import { Feedback } from "@frontend/components/ui/feedback";
import { useToastStore } from "@frontend/components/ui/toast-provider";
import {
  Heading,
  SubmitButton,
} from "@frontend/features/auth/components/auth-form";
import { AuthShell } from "@frontend/features/auth/components/auth-shell";
import { NewPasswordFields } from "@frontend/features/auth/components/new-password-fields";
import { postJson } from "@frontend/features/auth/lib/api";
import { readApiError } from "@frontend/features/auth/lib/errors";
import { formatKoreanTime } from "@frontend/features/auth/lib/format-korean-time";
import { useErrorFeedback } from "@frontend/features/auth/lib/use-error-feedback";
import Link from "next/link";
import { type SubmitEvent, useEffect, useRef, useState } from "react";

export const ResetPasswordScreen = ({
  token,
}: {
  token: string | undefined;
}) => {
  const [expiresAt, setExpiresAt] = useState<Date>();
  const [state, setState] = useState<
    "invalid" | "loading" | "ready" | "success"
  >("loading");
  const [pending, setPending] = useState(false);
  const [warning, setWarning] = useState(false);
  const showToast = useToastStore((state) => state.showToast);
  const dismissToast = useToastStore((state) => state.dismissToast);
  const { error, errorVersion, showError, clearError } = useErrorFeedback();
  const resetSession = useRef<
    { request: Promise<string | undefined>; token: string } | undefined
  >(undefined);

  useEffect(() => {
    if (!token) {
      setState("invalid");
      return;
    }
    const createResetSession = async () => {
      try {
        const response = await postJson("/api/auth/password-reset/session", {
          token,
        });
        if (!response.ok) return undefined;
        const result = (await response.json()) as { expiresAt: string };
        return result.expiresAt;
      } catch {
        return undefined;
      }
    };
    const request =
      resetSession.current?.token === token
        ? resetSession.current.request
        : createResetSession();
    resetSession.current = { request, token };
    let active = true;
    const applyResetSession = async () => {
      const nextExpiresAt = await request;
      if (!active) return;
      if (!nextExpiresAt) {
        setState("invalid");
        return;
      }
      setExpiresAt(new Date(nextExpiresAt));
      setState("ready");
    };
    void applyResetSession();
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (!expiresAt || state !== "ready") return;
    const delay = Math.max(0, expiresAt.getTime() - Date.now() - 2 * 60_000);
    const warningTimer = window.setTimeout(() => setWarning(true), delay);
    const expiryTimer = window.setTimeout(
      () => setState("invalid"),
      Math.max(0, expiresAt.getTime() - Date.now()),
    );
    return () => {
      window.clearTimeout(warningTimer);
      window.clearTimeout(expiryTimer);
    };
  }, [expiresAt, state]);

  useEffect(() => {
    if (!warning || state !== "ready") return;
    const id = showToast({
      tone: "warning",
      title: "재설정 시간 안내",
      message: "재설정 시간이 2분 남았어요. 지금 변경을 완료해주세요.",
    });
    return () => dismissToast(id);
  }, [warning, state, showToast, dismissToast]);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.get("password") !== data.get("passwordConfirmation")) {
      showError("비밀번호가 서로 일치하지 않습니다.");
      return;
    }
    clearError();
    setPending(true);
    try {
      const response = await postJson("/api/auth/password-reset/confirm", {
        password: data.get("password"),
      });
      if (response.ok) {
        setState("success");
        return;
      }
      const body = await readApiError(response);
      if (body.code === "invalid_or_expired_reset_session") {
        setState("invalid");
        return;
      }
      showError(
        body.message ?? "요청을 처리하지 못했습니다. 다시 시도해주세요.",
      );
    } catch {
      showError("요청을 처리하지 못했습니다. 다시 시도해주세요.");
    } finally {
      setPending(false);
    }
  };

  if (state === "loading") {
    return (
      <AuthShell>
        <Heading>재설정 링크 확인 중</Heading>
        <p
          className="m-0 text-center text-sm/5 text-text-secondary"
          aria-live="polite"
        >
          잠시만 기다려주세요.
        </p>
      </AuthShell>
    );
  }
  if (state === "invalid") {
    return (
      <AuthShell>
        <Heading>재설정 링크를 사용할 수 없어요</Heading>
        <Feedback tone="error">
          링크가 만료되었거나 이미 사용됐거나 올바르지 않아요.
        </Feedback>
        <ButtonLink variant="secondary" href="/forgot-password">
          재설정 메일 다시 받기
        </ButtonLink>
        <Link
          className="min-h-11 cursor-pointer border-0 text-inherit no-underline hover:underline hover:underline-offset-3"
          href="/login"
        >
          로그인으로 이동
        </Link>
      </AuthShell>
    );
  }
  if (state === "success") {
    return (
      <AuthShell>
        <Heading description="모든 브라우저에서 로그아웃 됐어요.">
          비밀번호를 변경했어요
        </Heading>
        <Feedback tone="success">새 비밀번호로 다시 로그인해주세요.</Feedback>
        <ButtonLink href="/login">로그인하러 가기</ButtonLink>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Heading
        description={
          expiresAt
            ? `${formatKoreanTime(expiresAt)}까지 변경을 완료해주세요.`
            : undefined
        }
      >
        새 비밀번호 설정
      </Heading>
      <form className="flex w-full flex-col gap-3" onSubmit={submit}>
        <NewPasswordFields />
        {error && (
          <Feedback tone="error" replayKey={errorVersion}>
            {error}
          </Feedback>
        )}
        <SubmitButton pending={pending}>비밀번호 변경</SubmitButton>
      </form>
    </AuthShell>
  );
};
