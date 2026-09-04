// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextPage } from 'next';
import Head from 'next/head';
import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { getSupabase, isSupabaseEnabled } from '../utils/supabase';
import SessionGateway from '../gateways/Session.gateway';

type Status = 'idle' | 'sending' | 'sent' | 'error';

const Login: NextPage = () => {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [signedInEmail, setSignedInEmail] = useState<string | undefined>();
  const enabled = isSupabaseEnabled();

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    supabase.auth.getUser().then(({ data }) => setSignedInEmail(data.user?.email ?? undefined));
  }, []);

  const sendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const supabase = getSupabase();
    if (!supabase) return;
    setStatus('sending');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined },
    });
    if (error) {
      setStatus('error');
      setMessage(error.message);
    } else {
      setStatus('sent');
      setMessage(`We sent a magic link to ${email}. Open it to sign in.`);
    }
  };

  const signOut = async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.auth.signOut();
    SessionGateway.demoteToAnonymous();
    setSignedInEmail(undefined);
    setStatus('idle');
    setMessage('');
  };

  return (
    <Layout>
      <Head>
        <title>Otel Demo - Sign in</title>
      </Head>
      <div style={{ maxWidth: 420, margin: '60px auto', padding: '0 20px' }}>
        <h1>Sign in</h1>
        {!enabled && (
          <p>
            Supabase Auth is not configured. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
            <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> to enable magic-link sign in. You can keep
            shopping anonymously in the meantime.
          </p>
        )}
        {enabled && signedInEmail && (
          <div>
            <p>Signed in as {signedInEmail}.</p>
            <button onClick={signOut}>Sign out</button>
          </div>
        )}
        {enabled && !signedInEmail && (
          <form onSubmit={sendMagicLink}>
            <p>Enter your email and we&apos;ll send you a magic link — no password required.</p>
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              style={{ width: '100%', padding: 10, marginBottom: 12 }}
            />
            <button type="submit" disabled={status === 'sending'} style={{ padding: '10px 16px' }}>
              {status === 'sending' ? 'Sending…' : 'Send magic link'}
            </button>
            {message && (
              <p style={{ marginTop: 16, color: status === 'error' ? 'crimson' : 'inherit' }}>{message}</p>
            )}
          </form>
        )}
      </div>
    </Layout>
  );
};

export default Login;
