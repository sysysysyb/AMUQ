"use client";

import { Feedback } from "@frontend/components/ui/feedback";
import {
  AuthField,
  Divider,
  Heading,
  SubmitButton,
} from "@frontend/features/auth/components/auth-form";
import { AuthShell } from "@frontend/features/auth/components/auth-shell";
import { GoogleButton } from "@frontend/features/auth/components/google-button";
import { postJson } from "@frontend/features/auth/lib/api";
import {
  loginErrorMessage,
  responseError,
} from "@frontend/features/auth/lib/errors";
import { formatKoreanTime } from "@frontend/features/auth/lib/format-korean-time";
import { useErrorFeedback } from "@frontend/features/auth/lib/use-error-feedback";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type SubmitEvent, useState, useTransition } from "react";

export const LoginScreen = ({
  authError,
}: {
  authError: string | undefined;
}) => {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const busy = pending || navigating;
  const { error, errorVersion, showError } = useErrorFeedback(
    loginErrorMessage(authError),
  );

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    const data = new FormData(event.currentTarget);
    try {
      const response = await postJson("/api/auth/login", {
        email: data.get("email"),
        password: data.get("password"),
      });
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) {
          showError("이메일 또는 비밀번호가 올바르지 않습니다.");
        } else if (response.status === 429) {
          const seconds = Number(response.headers.get("retry-after"));
          const retryAt = new Date(
            Date.now() +
              (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1_000,
          );
          showError(
            `로그인 요청이 너무 많습니다. ${formatKoreanTime(retryAt)} 이후 다시 시도해주세요.`,
          );
        } else {
          showError(await responseError(response));
        }
        return;
      }
      const result = (await response.json()) as {
        status?: string;
      };
      startNavigation(() =>
        router.push(
          result.status === "account_link_required" ? "/login/link" : "/",
        ),
      );
    } catch {
      showError(
        "로그인 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell>
      <Heading>로그인</Heading>
      <form className="flex w-full flex-col gap-3" onSubmit={submit}>
        <AuthField
          label="이메일"
          name="email"
          type="email"
          autoComplete="email"
        />
        <AuthField
          label="비밀번호"
          name="password"
          type="password"
          autoComplete="current-password"
        />
        <SubmitButton pending={busy}>로그인</SubmitButton>
      </form>
      {error && (
        <Feedback tone="error" replayKey={errorVersion}>
          {error}
        </Feedback>
      )}
      <Divider />
      <GoogleButton
        endpoint="/api/auth/google/start"
        onError={showError}
        disabled={busy}
        onPendingChange={setPending}
      />
      <div className="flex min-h-11 items-center justify-center gap-3 text-sm/5 font-medium text-action-hover">
        <Link
          className="inline-flex min-h-11 min-w-11 items-center justify-center text-inherit no-underline hover:underline hover:underline-offset-3"
          href="/forgot-password"
        >
          비밀번호를 잊으셨나요?
        </Link>
        <span aria-hidden="true">·</span>
        <Link
          className="inline-flex min-h-11 min-w-11 items-center justify-center text-inherit no-underline hover:underline hover:underline-offset-3"
          href="/signup"
        >
          회원가입
        </Link>
      </div>
    </AuthShell>
  );
};
