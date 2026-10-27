"use client";

import { Button, ButtonLink } from "@web/components/ui/button";
import { Feedback } from "@web/components/ui/feedback";
import { useToastStore } from "@web/components/ui/toast-provider";
import {
  AuthField,
  Heading,
  SubmitButton,
} from "@web/features/auth/components/auth-form";
import { AuthShell } from "@web/features/auth/components/auth-shell";
import { GoogleButton } from "@web/features/auth/components/google-button";
import { fetchAccountLinkStatus, postJson } from "@web/features/auth/lib/api";
import { loginErrorMessage, readApiError } from "@web/features/auth/lib/errors";
import { useErrorFeedback } from "@web/features/auth/lib/use-error-feedback";
import { cn } from "@web/lib/cn";
import { useRouter } from "next/navigation";
import {
  type SubmitEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type Provider = "google" | "password";

interface LinkStatus {
  email: string;
  requiredProvider: Provider;
}

export const AccountLinkScreen = ({
  authError,
}: {
  authError: string | undefined;
}) => {
  const router = useRouter();
  const [status, setStatus] = useState<LinkStatus>();
  const [statusError, setStatusError] = useState(false);
  const [statusVersion, setStatusVersion] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const { error, errorVersion, showError, clearError } = useErrorFeedback();
  const [linked, setLinked] = useState(false);
  const showToast = useToastStore((state) => state.showToast);
  const loadingRef = useRef<HTMLParagraphElement | null>(null);

  const focusStatusLoading = useCallback(
    (element: HTMLParagraphElement | null) => {
      loadingRef.current = element;
      if (element && statusVersion > 0) element.focus();
    },
    [statusVersion],
  );

  const focusLinkControl = useCallback(
    (element: HTMLElement | null) => {
      if (!element || (statusVersion === 0 && !invalid)) return;
      const document = element.ownerDocument;
      if (
        document.activeElement !== document.body &&
        document.activeElement !== loadingRef.current
      )
        return;
      const target =
        element.querySelector<HTMLElement>(
          "input:not(:disabled), button:not(:disabled), a[href]",
        ) ?? element;
      target.focus();
    },
    [invalid, statusVersion],
  );

  useEffect(() => {
    let active = true;
    const loadStatus = async () => {
      try {
        const response = await fetchAccountLinkStatus();
        if (!response.ok) {
          const body = await readApiError(response);
          if (!active) return;
          if (body.code === "account_link_required") setInvalid(true);
          else setStatusError(true);
          return;
        }
        const nextStatus = (await response.json()) as LinkStatus;
        if (active) setStatus(nextStatus);
      } catch {
        if (active) setStatusError(true);
      }
    };
    void loadStatus();
    return () => {
      active = false;
    };
  }, [statusVersion]);

  useEffect(() => {
    if (!linked) return;
    const timer = window.setTimeout(() => router.replace("/"), 1_200);
    return () => window.clearTimeout(timer);
  }, [linked, router]);

  const confirmPassword = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || linked) return;
    clearError();
    setPending(true);
    const data = new FormData(event.currentTarget);
    try {
      const response = await postJson("/api/auth/link/password", {
        consent: true,
        password: data.get("password"),
      });
      if (!response.ok) {
        const body = await readApiError(response);
        if (body.code === "account_link_required") {
          setInvalid(true);
          return;
        }
        showError(
          body.message ?? "비밀번호를 확인할 수 없습니다. 다시 입력해주세요.",
        );
        return;
      }
      showToast({
        tone: "success",
        title: "계정 연결 완료",
        message: "계정 연결이 완료됐어요.",
      });
      setLinked(true);
    } catch {
      showError("요청을 처리하지 못했습니다. 다시 시도해주세요.");
    } finally {
      setPending(false);
    }
  };

  if (invalid) {
    return (
      <AuthShell>
        <Heading>계정 연결을 다시 시작해 주세요</Heading>
        <Feedback tone="error">
          안전한 계정 연결 시간이 끝났어요. 다시 로그인해주세요.
        </Feedback>
        <ButtonLink ref={focusLinkControl} href="/login">
          로그인으로 이동
        </ButtonLink>
      </AuthShell>
    );
  }
  if (!status) {
    return (
      <AuthShell>
        <Heading>로그인</Heading>
        <p
          ref={focusStatusLoading}
          className={cn(
            statusError
              ? "sr-only"
              : "m-0 text-center text-sm/5 text-text-secondary",
          )}
          role="status"
          tabIndex={-1}
        >
          {!statusError && "계정 연결 정보를 확인하고 있어요."}
        </p>
        {statusError && (
          <>
            <Feedback tone="error">
              요청을 처리하지 못했습니다. 다시 시도해주세요.
            </Feedback>
            <Button
              ref={focusLinkControl}
              onClick={() => {
                setStatusError(false);
                setStatusVersion((version) => version + 1);
              }}
            >
              다시 시도
            </Button>
          </>
        )}
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Heading>로그인</Heading>
      {loginErrorMessage(authError) && (
        <Feedback tone="error">{loginErrorMessage(authError)}</Feedback>
      )}
      <Feedback>
        {status.requiredProvider === "password"
          ? "같은 이메일을 사용하는 계정이 있어요. 비밀번호를 확인하면 Google 계정과 연결됩니다."
          : "같은 이메일을 사용하는 Google 계정이 있어요. Google 계정으로 로그인하면 계정과 연결됩니다."}
      </Feedback>
      {status.requiredProvider === "password" ? (
        <form
          ref={focusLinkControl}
          className="flex w-full flex-col gap-3"
          onSubmit={confirmPassword}
        >
          <AuthField
            label="이메일"
            name="email"
            type="email"
            value={status.email}
            className="[&+label]:hidden"
            aria-label="이메일"
            disabled
          />
          <AuthField
            label="비밀번호"
            name="password"
            type="password"
            autoComplete="current-password"
          />
          {error && (
            <Feedback tone="error" replayKey={errorVersion}>
              {error}
            </Feedback>
          )}
          <SubmitButton pending={pending} disabled={linked}>
            동의하고 연결
          </SubmitButton>
        </form>
      ) : (
        <div ref={focusLinkControl} className="flex w-full flex-col gap-3">
          <GoogleButton
            endpoint="/api/auth/link/google"
            onError={showError}
            disabled={pending}
            onPendingChange={(nextPending) => {
              if (nextPending) clearError();
              setPending(nextPending);
            }}
          />
          {error && (
            <Feedback tone="error" replayKey={errorVersion}>
              {error}
            </Feedback>
          )}
        </div>
      )}
    </AuthShell>
  );
};
