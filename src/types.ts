import type { Permission, StaffUser } from './services/permissions.ts';
import type { SessionRecord } from './security/session.ts';

declare global {
  namespace Express {
    interface Request {
      /** Raw session token from the cookie. */
      sessionRaw?: string;
      /** Loaded session record (or null for anonymous/expired). */
      sessionRec?: SessionRecord | null;
      user?: StaffUser | null;
      perms?: Set<Permission>;
      isStaff?: boolean;
      flash?: { type: 'success' | 'error' | 'info'; msg: string } | null;
    }
  }
}

export {};
