"use client";

import { postJson } from "@frontend/features/auth/lib/api";
import { formatKoreanTime } from "@frontend/features/auth/lib/format-korean-time";
import { useErrorFeedback } from "@frontend/features/auth/lib/use-error-feedback";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

interface Challenge {
  attemptToken: string;
  codeExpiresAt: string;
  resendAvailableAt: string;
}
interface Proof {
  signupProof: string;
  proofExpiresAt: string;
}

const remainingSeconds = (expires: string | undefined, now: number) =>
  expires ? Math.max(0, Math.ceil((Date.parse(expires) - now) / 1_000)) : 0;
export type SignupOutcome =
  "created" | "already_completed" | "verification_completed" | "account_exists";

export const useSignupFlow = () => {
  const router = useRouter();
  const generation = useRef(0);
  const busy = useRef(false);
  const operationKey = useRef<string | undefined>(undefined);
  const serverTimeOffset = useRef(0);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [challenge, setChallenge] = useState<Challenge>();
  const [proof, setProof] = useState<Proof>();
  const [pending, setPending] = useState<"send" | "verify" | "complete">();
  const [blockedCode, setBlockedCode] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [completionRetryAt, setCompletionRetryAt] = useState(0);
  const [now, setNow] = useState(0);
  const [expired, setExpired] = useState(false);
  const [completed, setCompleted] = useState<SignupOutcome>();
  const [confirmationError, setConfirmationError] = useState<string>();
  const { error, errorVersion, showError, clearError } = useErrorFeedback();
  const currentTime = () => Date.now() + serverTimeOffset.current;
  const syncTime = (response: Response) => {
    const serverTime = Date.parse(response.headers.get("date") ?? "");
    if (Number.isFinite(serverTime))
      serverTimeOffset.current = serverTime - Date.now();
    setNow(currentTime());
  };

  const trackingTime =
    !completed &&
    (!!challenge || !!proof || retryAt > now || completionRetryAt > now);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!trackingTime) return;
    const tick = () => setNow(currentTime());
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [trackingTime]);

  useEffect(() => {
    if (proof && Date.parse(proof.proofExpiresAt) <= now) {
      setProof(undefined);
      setExpired(true);
      setCode("");
    }
  }, [now, proof]);

  const startRequest = (kind: "send" | "verify" | "complete") => {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(kind);
    clearError();
    return generation.current;
  };

  const endRequest = (request: number) => {
    if (request === generation.current) {
      busy.current = false;
      setPending(undefined);
    }
  };

  const requestError = (
    response: Response,
    body: { message?: string },
    kind: "challenge" | "completion" = "challenge",
  ) => {
    if (response.status === 429) {
      const seconds = Math.max(
        1,
        Number(response.headers.get("retry-after")) || 60,
      );
      const retry = currentTime() + seconds * 1_000;
      if (kind === "completion") setCompletionRetryAt(retry);
      else setRetryAt(retry);
      setNow(currentTime());
      showError(
        `${formatKoreanTime(new Date(retry))} 이후 다시 요청해 주세요.`,
      );
    } else
      showError(
        body.message ?? "요청을 처리하지 못했습니다. 다시 시도해주세요.",
      );
  };

  const requestCode = async () => {
    if (proof || currentTime() < retryAt) return;

    const request = startRequest("send");

    if (request === undefined) return;
    try {
      operationKey.current ??= crypto.randomUUID();

      const response = await postJson(
        challenge
          ? "/api/auth/signup/challenges/resend"
          : "/api/auth/signup/challenges",
        challenge
          ? {
              attemptToken: challenge.attemptToken,
              operationKey: operationKey.current,
            }
          : { email, operationKey: operationKey.current },
      );

      const body = response.status === 429 ? {} : await response.json();

      if (request !== generation.current) return;

      syncTime(response);

      if (!response.ok) {
        if (
          response.status === 400 &&
          body.code === "invalid_or_expired_challenge"
        ) {
          setChallenge(undefined);
          setCode("");
          setBlockedCode(false);
          operationKey.current = undefined;
        }
        requestError(response, body);
        return;
      }
      operationKey.current = undefined;
      setChallenge(body);
      setCode("");
      setBlockedCode(false);
      setNow(currentTime());
    } catch {
      if (request === generation.current)
        showError("요청을 처리하지 못했습니다. 다시 시도해주세요.");
    } finally {
      endRequest(request);
    }
  };

  const verifyCode = async () => {
    if (
      !challenge ||
      !/^[0-9]{6}$/.test(code) ||
      blockedCode ||
      remainingSeconds(challenge.codeExpiresAt, currentTime()) === 0
    )
      return;

    const request = startRequest("verify");

    if (request === undefined) return;

    try {
      const response = await postJson("/api/auth/signup/challenges/verify", {
        attemptToken: challenge.attemptToken,
        code,
      });

      const body = response.status === 429 ? {} : await response.json();

      if (request !== generation.current) return;

      syncTime(response);

      if (body.status === "verified" && response.ok) {
        setProof(body);
        setExpired(false);
        setNow(currentTime());
      } else if (body.status === "already_completed") {
        setCompleted("verification_completed");
        setPassword("");
        setConfirmation("");
        setProof(undefined);
        setChallenge(undefined);
      } else if (body.status === "invalid_code") {
        showError(
          `인증번호가 일치하지 않습니다. 남은 시도 ${body.remainingAttempts}회`,
        );
      } else if (
        ["expired", "attempts_exhausted", "invalid_challenge"].includes(
          body.status,
        )
      ) {
        setBlockedCode(true);
        if (body.status === "invalid_challenge") setChallenge(undefined);
        showError("인증번호를 사용할 수 없어요. 인증번호를 다시 받아주세요.");
      } else requestError(response, body);
    } catch {
      if (request === generation.current)
        showError("요청을 처리하지 못했습니다. 다시 시도해주세요.");
    } finally {
      endRequest(request);
    }
  };

  const completeSignup = async (focusConfirmation: () => void) => {
    if (currentTime() < completionRetryAt) return;

    if (!proof || Date.parse(proof.proofExpiresAt) <= currentTime()) {
      if (proof) {
        setProof(undefined);
        setExpired(true);
      }
      return;
    }

    if (password !== confirmation) {
      setConfirmationError("비밀번호와 일치하지 않습니다.");
      focusConfirmation();
      return;
    }

    const request = startRequest("complete");

    if (request === undefined) return;

    try {
      const response = await postJson("/api/auth/signup/complete", {
        signupProof: proof.signupProof,
        password,
      });

      const body = response.status === 429 ? {} : await response.json();

      if (request !== generation.current) return;

      if (body.status === "expired" || body.status === "invalid_proof") {
        setProof(undefined);
        setExpired(true);
      } else if (!response.ok) requestError(response, body, "completion");
      else if (body.status === "account_link_required")
        router.push("/login/link");
      else if (
        ["created", "already_completed", "account_exists"].includes(body.status)
      ) {
        setCompleted(body.status);
        setPassword("");
        setConfirmation("");
        setProof(undefined);
        setChallenge(undefined);
      } else showError("요청을 처리하지 못했습니다. 다시 시도해주세요.");
    } catch {
      if (request === generation.current)
        showError("요청을 처리하지 못했습니다. 다시 시도해주세요.");
    } finally {
      endRequest(request);
    }
  };

  const changeEmail = (value: string) => {
    generation.current += 1;
    busy.current = false;
    operationKey.current = undefined;
    setPending(undefined);
    setEmail(value);
    setChallenge(undefined);
    setProof(undefined);
    setCode("");
    setExpired(false);
    setBlockedCode(false);
    clearError();
  };

  const changePassword = (value: string) => {
    setPassword(value);
    setConfirmationError(undefined);
  };

  const changeConfirmation = (value: string) => {
    setConfirmation(value);
    setConfirmationError(undefined);
  };

  const codeSeconds = remainingSeconds(challenge?.codeExpiresAt, now);

  const resendSeconds = Math.max(
    remainingSeconds(challenge?.resendAvailableAt, now),
    Math.max(0, Math.ceil((retryAt - now) / 1_000)),
  );

  return {
    email,
    code,
    password,
    confirmation,
    challenge,
    proof,
    pending,
    blockedCode,
    expired,
    completed,
    completionRetryAt,
    now,
    confirmationError,
    error,
    errorVersion,
    codeSeconds,
    resendSeconds,
    changeEmail,
    changeCode: setCode,
    changePassword,
    changeConfirmation,
    requestCode,
    verifyCode,
    completeSignup,
  };
};
