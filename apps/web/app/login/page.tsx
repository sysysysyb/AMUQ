import { LoginScreen } from "@web/features/auth/screens/login-screen";

const LoginPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string }>;
}) => {
  const { authError } = await searchParams;
  return <LoginScreen authError={authError} />;
};

export default LoginPage;
