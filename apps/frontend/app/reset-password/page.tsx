import { ResetPasswordScreen } from "@frontend/features/auth/screens/reset-password-screen";

const ResetPasswordPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) => {
  const { token } = await searchParams;
  return <ResetPasswordScreen token={token} />;
};

export default ResetPasswordPage;
