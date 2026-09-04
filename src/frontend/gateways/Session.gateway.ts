// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { v4 } from 'uuid';

interface ISession {
  userId: string;
  currencyCode: string;
  // Present when the user is signed in via Supabase Auth; absent for anonymous sessions.
  email?: string;
  isAuthenticated?: boolean;
}

const sessionKey = 'session';
const defaultSession: Readonly<ISession> = Object.freeze({
  userId: v4(),
  currencyCode: 'USD',
});

const SessionGateway = () => ({
  getSession(): ISession {
    if (typeof window === 'undefined') return defaultSession;
    const sessionString = localStorage.getItem(sessionKey);

    if (sessionString) {
      try {
        const parsed: unknown = JSON.parse(sessionString);
        if (isValid(parsed)) {
          return parsed;
        }
      } catch (e) {
        console.warn('Failed to parse session from localStorage', e);
      }
    }
    localStorage.setItem(sessionKey, JSON.stringify(defaultSession));
    return defaultSession;
  },
  setSessionValue<K extends keyof ISession>(key: K, value: ISession[K]) {
    const session = this.getSession();

    localStorage.setItem(sessionKey, JSON.stringify({ ...session, [key]: value }));
  },
  // Map a signed-in Supabase user onto the session so their id flows into cart/checkout.
  promoteToUser(userId: string, email?: string) {
    const session = this.getSession();
    localStorage.setItem(
      sessionKey,
      JSON.stringify({ ...session, userId, email, isAuthenticated: true })
    );
  },
  // Revert to a fresh anonymous identity on sign-out (new cart, keep currency).
  demoteToAnonymous() {
    const session = this.getSession();
    localStorage.setItem(
      sessionKey,
      JSON.stringify({ userId: v4(), currencyCode: session.currencyCode })
    );
  },
});

const isValid = (session: unknown): session is ISession => {
  return (
    typeof session === 'object' &&
    session !== null &&
    typeof (session as ISession).userId === 'string' &&
    typeof (session as ISession).currencyCode === 'string'
  );
};

export default SessionGateway();
