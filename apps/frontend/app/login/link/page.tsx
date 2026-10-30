import { AccountLinkScreen } from "@frontend/features/auth/screens/account-link-screen";

const AccountLinkPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string }>;
}) => {
  const { authError } = await searchParams;
  return <AccountLinkScreen authError={authError} />;
};

export default AccountLinkPage;
