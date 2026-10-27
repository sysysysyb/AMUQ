"use client";

import { cn } from "@web/lib/cn";
import { cva } from "class-variance-authority";
import Image from "next/image";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export type FeedbackTone = "error" | "info" | "success" | "warning";

const FEEDBACK_ICON_SIZE = 20;
const FEEDBACK_CLOSE_BUTTON_SIZE = 44;
const feedbackIconLabels: Record<FeedbackTone, string> = {
  error: "오류",
  info: "안내",
  success: "성공",
  warning: "주의",
};

const feedbackVariants = cva(
  "flex items-center gap-3 rounded-xl ring-1 ring-inset",
  {
    variants: {
      kind: {
        inline: "w-full px-4 py-3",
        toast: "w-[342px] max-w-full py-4 pl-4 shadow-toast",
      },
      tone: {
        error: "bg-danger-bg text-danger ring-danger",
        info: "bg-bg-selected text-action-primary ring-action-primary",
        success: "bg-success-bg text-success ring-success",
        warning: "bg-warning-bg text-warning ring-warning",
      },
    },
    defaultVariants: { kind: "inline", tone: "info" },
  },
);

type FeedbackProps = {
  children: ReactNode;
  title?: string;
  tone?: FeedbackTone;
  className?: string;
  role?: "alert" | "status";
  replayKey?: number;
} & (
  | { kind?: "inline"; onDismiss?: never }
  | { kind: "toast"; onDismiss: () => void }
);

export const Feedback = ({
  children,
  title,
  tone = "info",
  className,
  role,
  kind = "inline",
  onDismiss,
  replayKey = 0,
}: FeedbackProps) => {
  const [animation, setAnimation] = useState<"grow" | "content">("grow");
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousFeedback = useRef<{
    text: string | null;
    tone: FeedbackTone;
    kind: "inline" | "toast";
    replayKey: number;
  } | null>(null);

  useLayoutEffect(() => {
    const previous = previousFeedback.current;
    const text = contentRef.current?.textContent ?? null;
    if (
      !previous ||
      kind !== "inline" ||
      (previous.text === text &&
        previous.tone === tone &&
        previous.kind === kind &&
        previous.replayKey === replayKey)
    ) {
      previousFeedback.current = { text, tone, kind, replayKey };
      return;
    }

    const nextAnimation =
      previous.tone === tone && previous.kind === kind ? "content" : "grow";
    if (animation !== nextAnimation) {
      setAnimation(nextAnimation);
      return;
    }
    previousFeedback.current = { text, tone, kind, replayKey };
    const target = animation === "grow" ? containerRef : contentRef;
    for (const effect of target.current?.getAnimations() ?? []) {
      effect.cancel();
      effect.play();
    }
  }, [children, title, tone, kind, animation, replayKey]);

  return (
    <div
      ref={containerRef}
      className={cn(
        feedbackVariants({ kind, tone }),
        kind === "inline" &&
          animation === "grow" &&
          "origin-center motion-safe:animate-feedback-grow",
        className,
      )}
      data-kind={kind}
      data-tone={tone}
      role={
        role ??
        (tone === "error" ? "alert" : kind === "toast" ? "status" : undefined)
      }
    >
      <Image
        className="size-5 shrink-0"
        src={`/icons/${tone}.svg`}
        alt={feedbackIconLabels[tone]}
        width={FEEDBACK_ICON_SIZE}
        height={FEEDBACK_ICON_SIZE}
      />
      <div
        ref={contentRef}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere",
          kind === "inline" &&
            animation === "content" &&
            "motion-safe:animate-feedback-content",
        )}
      >
        {title && (
          <p className="m-0 text-sm/5 font-normal text-current">{title}</p>
        )}
        <p
          key={replayKey}
          className="m-0 text-base/6 font-medium text-text-feedback"
        >
          {children}
        </p>
      </div>
      {kind === "toast" && (
        <button
          type="button"
          aria-label="알림 닫기"
          className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent p-0"
          onClick={onDismiss}
        >
          <Image
            src="/icons/close.svg"
            alt="닫기"
            aria-hidden="true"
            width={FEEDBACK_CLOSE_BUTTON_SIZE}
            height={FEEDBACK_CLOSE_BUTTON_SIZE}
          />
        </button>
      )}
    </div>
  );
};
