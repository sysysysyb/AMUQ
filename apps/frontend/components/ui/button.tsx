import { cn } from "@frontend/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import Link from "next/link";
import { type ComponentProps } from "react";

const buttonVariants = cva(
  "flex min-h-11 w-full cursor-pointer items-center justify-center rounded-xl border-solid text-sm/5 font-bold no-underline active:not-disabled:inset-shadow-button-active",
  {
    variants: {
      variant: {
        primary:
          "border-0 bg-action-primary px-5 py-3 text-text-inverse hover:not-disabled:bg-action-hover active:not-disabled:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50",
        secondary:
          "border border-action-primary bg-bg-surface px-5 py-[11px] text-action-primary hover:not-disabled:bg-bg-selected active:not-disabled:bg-bg-selected disabled:cursor-not-allowed disabled:opacity-50",
      },
    },
    defaultVariants: { variant: "primary" },
  },
);

export const Button = ({
  className,
  variant,
  type = "button",
  ...properties
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) => (
  <button
    type={type}
    className={cn(buttonVariants({ variant }), className)}
    {...properties}
  />
);

export const ButtonLink = ({
  className,
  variant,
  ...properties
}: ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>) => (
  <Link
    className={cn(buttonVariants({ variant }), className)}
    {...properties}
  />
);
