"use client";

import { Feedback } from "@frontend/components/ui/feedback";
import {
  AuthField,
  Heading,
  SubmitButton,
} from "@frontend/features/auth/components/auth-form";
import { AuthShell } from "@frontend/features/auth/components/auth-shell";
import { EmailRequestFeedback } from "@frontend/features/auth/components/email-request-feedback";
import { EmailResendButton } from "@frontend/features/auth/components/email-resend-button";
import { useEmailRequest } from "@frontend/features/auth/lib/use-email-request";
import { useState } from "react";

export const ForgotPasswordScreen = () => {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { send, pending, retryAt, error, version } = useEmailRequest(
    "/api/auth/password-reset/request",
  );

  const request = async (emailAddress: string) => {
    if (await send(emailAddress)) setSent(true);
  };

  if (sent) {
    return (
      <AuthShell>
        <Heading description="계정이 있다면 재설정 링크를 보냈어요.">
          메일을 확인해 주세요
        </Heading>
        <Feedback tone="success">
          보안을 위해 해당 이메일의 가입 여부는 알려드리지 않아요.
        </Feedback>
        <EmailResendButton
          email={email}
          endpoint="/api/auth/password-reset/resend"
          label="메일 다시 보내기"
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Heading description="가입한 이메일로 재설정 링크를 보내드릴게요.">
        비밀번호 재설정
      </Heading>
      <form
        className="flex w-full flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const nextEmail = String(
            new FormData(event.currentTarget).get("email") ?? "",
          );
          setEmail(nextEmail);
          void request(nextEmail);
        }}
      >
        <AuthField
          label="이메일"
          name="email"
          type="email"
          autoComplete="email"
        />
        <EmailRequestFeedback
          retryAt={retryAt}
          error={error}
          version={version}
        />
        <SubmitButton pending={pending} disabled={Boolean(retryAt)}>
          재설정 메일 보내기
        </SubmitButton>
      </form>
    </AuthShell>
  );
};
