import { AuthField } from "@web/features/auth/components/auth-form";
import { type ComponentProps } from "react";

type PasswordFieldProps = Pick<
  ComponentProps<typeof AuthField>,
  "value" | "onChange" | "disabled" | "errorMessage"
>;

export const NewPasswordFields = ({
  password,
  confirmation,
}: {
  password?: PasswordFieldProps;
  confirmation?: PasswordFieldProps;
}) => (
  <>
    <AuthField
      label="비밀번호"
      name="password"
      type="password"
      autoComplete="new-password"
      minLength={12}
      {...password}
    />
    <AuthField
      label="비밀번호 확인"
      name="passwordConfirmation"
      type="password"
      autoComplete="new-password"
      {...confirmation}
    />
  </>
);
