import { Feedback } from "@web/components/ui/feedback";

export const EmailRequestFeedback = ({
  retryAt,
  error,
  version,
}: {
  retryAt: string | undefined;
  error: string | undefined;
  version: number;
}) =>
  retryAt ? (
    <Feedback tone="warning" role="alert">
      요청이 많아 잠시 제한됐어요. {retryAt}부터 메일을 다시 보낼 수 있어요.
    </Feedback>
  ) : error ? (
    <Feedback tone="error" replayKey={version}>
      {error}
    </Feedback>
  ) : null;
