"use client";

import { cn } from "@frontend/lib/cn";
import Image from "next/image";
import { type InputHTMLAttributes, useId, useState } from "react";

const PASSWORD_TOGGLE_ICON_SIZE = 20;

export const Field = ({
  label,
  name,
  className,
  onChange,
  onBlur,
  onInvalid,
  errorMessage,
  validate,
  ...properties
}: {
  label: string;
  name: string;
  errorMessage?: string | undefined;
  validate?: ((input: HTMLInputElement) => string | undefined) | undefined;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "name">) => {
  const id = useId();
  const [error, setError] = useState<string>();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const isPassword = properties.type === "password";
  const message = error ?? errorMessage;
  const errorId = `${id}-error`;
  const getError = (input: HTMLInputElement) =>
    validate ? validate(input) : input.validationMessage || undefined;
  return (
    <div className="relative w-full md:pt-2">
      <input
        id={id}
        name={name}
        className={cn(
          "peer h-12 w-full rounded-xl border border-solid border-border-default bg-bg-surface px-3 py-0 text-sm/5 text-text-primary autofill:inset-shadow-[0_0_0_1000px_var(--color-bg-surface)] focus:border-action-primary focus:shadow-[0_0_0_3px_var(--color-focus-ring)] focus:outline-none hover:enabled:not-focus:border-border-hover disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-text-secondary disabled:opacity-100",
          isPassword && "pr-14",
          className,
        )}
        placeholder=" "
        {...properties}
        type={isPassword && passwordVisible ? "text" : properties.type}
        aria-invalid={message ? true : properties["aria-invalid"]}
        aria-describedby={
          [properties["aria-describedby"], message ? errorId : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onChange={(event) => {
          const message = getError(event.currentTarget);
          if (validate) event.currentTarget.setCustomValidity(message ?? "");
          if (error) setError(message);
          onChange?.(event);
        }}
        onBlur={(event) => {
          const message = getError(event.currentTarget);
          if (validate) event.currentTarget.setCustomValidity(message ?? "");
          if (event.currentTarget.value || error || errorMessage)
            setError(message);
          onBlur?.(event);
        }}
        onInvalid={(event) => {
          event.preventDefault();
          setError(getError(event.currentTarget));
          event.currentTarget.form
            ?.querySelector<HTMLInputElement>("input:invalid")
            ?.focus();
          onInvalid?.(event);
        }}
      />
      <label
        className="pointer-events-none absolute top-3.5 left-3 origin-left bg-bg-surface px-1 py-0 text-sm/5 font-medium text-text-secondary transition-[top,font-size,color] duration-300 ease-in-out peer-not-placeholder-shown:-top-2 peer-not-placeholder-shown:text-xs/4 peer-autofill:-top-2 peer-autofill:text-xs/4 peer-focus:-top-2 peer-focus:text-xs/4 peer-disabled:bg-bg-subtle md:top-5.5 md:peer-not-placeholder-shown:top-0 md:peer-autofill:top-0 md:peer-focus:top-0"
        htmlFor={id}
      >
        {label}
      </label>
      {isPassword && (
        <button
          type="button"
          className="absolute top-0.5 right-1 flex size-11 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent p-0 text-text-secondary hover:bg-bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-primary disabled:cursor-not-allowed md:top-2.5"
          aria-label={`${label} ${passwordVisible ? "숨기기" : "표시"}`}
          aria-controls={id}
          aria-pressed={passwordVisible}
          disabled={properties.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setPasswordVisible((visible) => !visible)}
        >
          <Image
            src={`/icons/eye${passwordVisible ? "-off" : ""}.svg`}
            alt={passwordVisible ? "비밀번호 숨기기" : "비밀번호 표시"}
            aria-hidden="true"
            width={PASSWORD_TOGGLE_ICON_SIZE}
            height={PASSWORD_TOGGLE_ICON_SIZE}
          />
        </button>
      )}
      {message && (
        <p id={errorId} className="m-0 mt-2 text-xs/4 text-danger" role="alert">
          {message}
        </p>
      )}
    </div>
  );
};
