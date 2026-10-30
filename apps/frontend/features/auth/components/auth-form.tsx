"use client";

import { Button } from "@frontend/components/ui/button";
import { Field } from "@frontend/components/ui/field";
import { authFieldErrorMessage } from "@frontend/features/auth/lib/auth-validation";
import { type ComponentProps, type ReactNode } from "react";

export const Heading = ({
  children,
  description,
}: {
  children: ReactNode;
  description?: string | undefined;
}) => {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <h1 className="m-0 text-heading-02 font-semibold">{children}</h1>
      {description && (
        <p className="m-0 text-sm/5 font-medium text-text-description">
          {description}
        </p>
      )}
    </div>
  );
};

export const AuthField = (
  properties: Omit<ComponentProps<typeof Field>, "validate">,
) => (
  <Field
    required
    {...properties}
    validate={(input) => authFieldErrorMessage(input, properties.type)}
  />
);

export const SubmitButton = ({
  children,
  pending,
  disabled = false,
}: {
  children: ReactNode;
  pending: boolean;
  disabled?: boolean;
}) => {
  return (
    <Button type="submit" disabled={pending || disabled}>
      {pending ? "처리 중" : children}
    </Button>
  );
};

export const Divider = () => {
  return (
    <div className="flex h-5 items-center gap-2 text-xs/4 text-text-secondary before:h-px before:flex-1 before:bg-border-default before:content-[''] after:h-px after:flex-1 after:bg-border-default after:content-['']">
      또는
    </div>
  );
};
