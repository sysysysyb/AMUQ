"use client";

import { Button } from "@web/components/ui/button";
import { Feedback } from "@web/components/ui/feedback";
import {
  AuthField,
  Heading,
  SubmitButton,
} from "@web/features/auth/components/auth-form";
import { AuthShell } from "@web/features/auth/components/auth-shell";
import { NewPasswordFields } from "@web/features/auth/components/new-password-fields";
import { SignupResult } from "@web/features/auth/components/signup-result";
import { useSignupFlow } from "@web/features/auth/lib/use-signup-flow";
import Link from "next/link";
import { type SubmitEvent, useLayoutEffect, useRef } from "react";

const countdown = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

export const SignupScreen = () => {
  const signup = useSignupFlow();
  const { challenge, proof, expired } = signup;
  const form = useRef<HTMLFormElement>(null);
  const resendButton = useRef<HTMLButtonElement>(null);
  const expiryNotice = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const name = proof ? "password" : challenge ? "code" : undefined;
    if (name)
      form.current
        ?.querySelector<HTMLInputElement>(`[name="${name}"]`)
        ?.focus();
  }, [challenge, proof]);

  useLayoutEffect(() => {
    if (!expired) return;
    if (resendButton.current && !resendButton.current.disabled)
      resendButton.current.focus();
    else expiryNotice.current?.focus();
  }, [expired]);

  const requestCode = () => {
    const input =
      form.current?.querySelector<HTMLInputElement>('[name="email"]');
    if (input?.reportValidity()) void signup.requestCode();
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void signup.completeSignup(() => {
      form.current
        ?.querySelector<HTMLInputElement>('[name="passwordConfirmation"]')
        ?.focus();
    });
  };

  if (signup.completed) return <SignupResult outcome={signup.completed} />;

  return (
    <AuthShell>
      <Heading description="이메일 인증 후 비밀번호를 설정해주세요.">
        회원가입
      </Heading>
      <form ref={form} className="flex w-full flex-col gap-3" onSubmit={submit}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <AuthField
              label="이메일"
              name="email"
              type="email"
              autoComplete="email"
              value={signup.email}
              onChange={(event) =>
                signup.changeEmail(event.currentTarget.value)
              }
            />
          </div>
          <Button
            ref={resendButton}
            className="h-12 w-24 shrink-0 px-3 md:mt-2"
            disabled={
              !signup.email ||
              !!signup.pending ||
              !!proof ||
              signup.resendSeconds > 0
            }
            onClick={requestCode}
          >
            {signup.pending === "send"
              ? "전송 중"
              : proof
                ? "인증 완료"
                : challenge
                  ? "재전송"
                  : "인증 요청"}
          </Button>
        </div>
        {challenge && !proof && (
          <>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <AuthField
                  label="인증번호"
                  name="code"
                  type="text"
                  required={false}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={signup.code}
                  onChange={(event) =>
                    signup.changeCode(event.currentTarget.value)
                  }
                  disabled={
                    !!signup.pending ||
                    signup.blockedCode ||
                    signup.codeSeconds === 0
                  }
                />
              </div>
              <Button
                className="h-12 w-24 shrink-0 px-3 md:mt-2"
                disabled={
                  !!signup.pending ||
                  signup.blockedCode ||
                  signup.codeSeconds === 0 ||
                  !/^[0-9]{6}$/.test(signup.code)
                }
                onClick={() => void signup.verifyCode()}
              >
                {signup.pending === "verify" ? "확인 중" : "인증 확인"}
              </Button>
            </div>
            <p className="m-0 text-sm/5 text-text-secondary">
              {signup.codeSeconds > 0
                ? `남은 시간 ${countdown(signup.codeSeconds)}`
                : "인증번호가 만료됐어요. 재전송해 주세요."}
            </p>
            <p className="m-0 text-sm/5 text-text-secondary">
              이메일에서 인증번호 6자리를 확인해주세요.{" "}
              {signup.resendSeconds > 0
                ? `재전송까지 ${signup.resendSeconds}초`
                : "재전송은 1시간에 최대 3회 가능합니다."}
            </p>
          </>
        )}
        {proof && (
          <Feedback tone="success">
            이메일 인증이 완료됐어요. 30분 안에 가입을 완료해 주세요.
          </Feedback>
        )}
        <div
          ref={expiryNotice}
          role="status"
          tabIndex={-1}
          className={expired ? undefined : "sr-only"}
        >
          {expired && (
            <Feedback>
              인증이 만료됐어요. 입력한 비밀번호는 유지되며 이메일을 다시 인증해
              주세요.
            </Feedback>
          )}
        </div>
        <NewPasswordFields
          password={{
            value: signup.password,
            disabled: !proof || !!signup.pending,
            onChange: (event) =>
              signup.changePassword(event.currentTarget.value),
          }}
          confirmation={{
            value: signup.confirmation,
            disabled: !proof || !!signup.pending,
            errorMessage: signup.confirmationError,
            onChange: (event) =>
              signup.changeConfirmation(event.currentTarget.value),
          }}
        />
        {proof && (
          <p className="m-0 text-xs/4 text-text-secondary">
            비밀번호는 12~20자로, 영문 대문자와 소문자 및 숫자를 포함해주세요.
          </p>
        )}
        {signup.error && (
          <Feedback tone="error" replayKey={signup.errorVersion}>
            {signup.error}
          </Feedback>
        )}
        <SubmitButton
          pending={signup.pending === "complete"}
          disabled={
            !proof || !!signup.pending || signup.completionRetryAt > signup.now
          }
        >
          회원가입
        </SubmitButton>
        <Link
          className="flex min-h-11 items-center justify-center text-sm/5 text-action-primary no-underline hover:underline hover:underline-offset-3"
          href="/login"
        >
          이미 계정이 있나요? 로그인
        </Link>
      </form>
    </AuthShell>
  );
};
