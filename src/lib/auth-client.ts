import { createAuthClient } from 'better-auth/svelte';

// Client-side counterpart of src/lib/server/auth.ts. The base URL defaults to
// the current origin, which is right for a self-hosted single-origin app.
export const authClient = createAuthClient();
