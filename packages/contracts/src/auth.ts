export const authProviders = ["password", "google"] as const;

export type AuthProvider = (typeof authProviders)[number];

export interface AuthenticatedUser {
  id: string;
  email: string;
  emailVerified: boolean;
}
