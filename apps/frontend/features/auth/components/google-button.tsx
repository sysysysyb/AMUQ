"use client";

import { postJson } from "@frontend/features/auth/lib/api";
import { responseError } from "@frontend/features/auth/lib/errors";
import Image from "next/image";
import { useEffect, useEffectEvent, useRef, useState } from "react";

export const GoogleButton = ({
  endpoint,
  onError,
  disabled,
  onPendingChange,
}: {
  endpoint: string;
  onError: (message: string) => void;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
}) => {
  const [phase, setPhase] = useState<"request" | "navigation">();
  // Browser cancellation can fire before React commits the navigation phase.
  const handingOff = useRef(false);
  const mounted = useRef(false);
  const pending = phase !== undefined;
  const restorePending = useEffectEvent((timedOut = false) => {
    if (!handingOff.current) return;
    handingOff.current = false;
    setPhase(undefined);
    onPendingChange(false);
    if (timedOut) {
      onError("Google 로그인 화면으로 이동하지 못했습니다. 다시 시도해주세요.");
    }
  });

  useEffect(() => {
    mounted.current = true;
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      restorePending();
    };
    const cancelled = () => restorePending();
    window.addEventListener("pageshow", restore);
    const navigation = window.navigation;
    navigation?.addEventListener("navigateerror", cancelled);
    return () => {
      mounted.current = false;
      window.removeEventListener("pageshow", restore);
      navigation?.removeEventListener("navigateerror", cancelled);
    };
  }, []);

  useEffect(() => {
    if (phase !== "navigation") return;
    const timer = window.setTimeout(() => restorePending(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const start = async () => {
    let navigating = false;
    setPhase("request");
    onPendingChange(true);
    try {
      const response = await postJson(endpoint, { returnTo: "/" });
      if (!response.ok) {
        const message = await responseError(response);
        if (mounted.current) onError(message);
        return;
      }
      const { authorizationUrl } = (await response.json()) as {
        authorizationUrl: string;
      };
      if (!mounted.current) return;
      const destination = new URL(authorizationUrl, window.location.origin);
      if (
        destination.protocol !== "http:" &&
        destination.protocol !== "https:"
      ) {
        onError("Google 로그인을 시작할 수 없습니다.");
        return;
      }
      setPhase("navigation");
      handingOff.current = true;
      window.location.assign(destination.href);
      navigating = true;
    } catch {
      if (mounted.current)
        onError(
          "Google 로그인에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.",
        );
    } finally {
      if (!navigating && mounted.current) {
        handingOff.current = false;
        setPhase(undefined);
        onPendingChange(false);
      }
    }
  };

  return (
    <button
      className="flex h-12 min-h-11 w-full cursor-pointer items-center justify-center gap-2.5 rounded-lg border border-solid border-google-border bg-bg-surface px-3 py-0 font-google text-sm/5 font-medium text-google-label hover:enabled:border-google-border-hover hover:enabled:bg-google-hover active:enabled:border-google-border active:enabled:bg-bg-subtle active:enabled:inset-shadow-button-active"
      type="button"
      disabled={disabled || pending}
      onClick={() => void start()}
    >
      <Image
        className="size-4.5"
        src="/icons/google.svg"
        alt=""
        width={18}
        height={18}
      />
      {pending ? "Google 연결 중" : "Google 계정으로 로그인"}
    </button>
  );
};
