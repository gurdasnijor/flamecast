import { createAuthClient } from "better-auth/react";

// VITE_API_URL is e.g. "http://localhost:3001/api" or "https://example.com/api".
// better-auth expects the server origin (it appends /api/auth/* itself).
const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
const baseURL = apiUrl ? apiUrl.replace(/\/api\/?$/, "") : undefined;

export const authClient = createAuthClient({ baseURL });

export const { useSession, signIn, signOut } = authClient;
