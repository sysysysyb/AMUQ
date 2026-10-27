"use client";

import { Button } from "@web/components/ui/button";
import { EmailRequestFeedback } from "@web/features/auth/components/email-request-feedback";
import { useEmailRequest } from "@web/features/auth/lib/use-email-request";

export const EmailResendButton = ({
  email,
  endpoint,
  label,
}: {
  email: string;
  endpoint: string;
  label: string;
}) => {
  const { send, pending, rateLimit, retryAt, error, completed, version } =
    useEmailRequest(endpoint);
  return (
    <div className="flex w-full flex-col gap-2">
      <Button
        variant="secondary"
        type="button"
        disabled={pending || Boolean(retryAt)}
        onClick={() => void send(email)}
      >
        {pending ? "보내는 중…" : label}
      </Button>
      <p
        className="m-0 text-center text-xs/4 text-success"
        role="status"
        aria-atomic="true"
      >
        {completed && rateLimit
          ? `재전송이 완료됐습니다. (${rateLimit.limit - rateLimit.remaining}/${rateLimit.limit})`
          : ""}
      </p>
      <EmailRequestFeedback retryAt={retryAt} error={error} version={version} />
    </div>
  );
};
