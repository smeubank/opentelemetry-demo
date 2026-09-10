// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import '../styles/globals.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App, { AppContext, AppProps } from 'next/app';
import CurrencyProvider from '../providers/Currency.provider';
import CartProvider from '../providers/Cart.provider';
import { ThemeProvider } from 'styled-components';
import Theme from '../styles/Theme';
import * as Sentry from '@sentry/nextjs';
import FrontendTracer from '../utils/telemetry/FrontendTracer';
import SessionGateway from '../gateways/Session.gateway';
import { getSupabase } from '../utils/supabase';
import { OpenFeatureProvider, OpenFeature } from '@openfeature/react-sdk';
import { FlagdWebProvider } from '@openfeature/flagd-web-provider';

declare global {
  interface Window {
    ENV: {
      NEXT_PUBLIC_PLATFORM?: string;
      NEXT_PUBLIC_OTEL_SERVICE_NAME?: string;
      NEXT_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
      IS_SYNTHETIC_REQUEST?: string;
      NEXT_PUBLIC_SUPABASE_URL?: string;
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
      NEXT_PUBLIC_SUPABASE_STORAGE_BASE_URL?: string;
      NEXT_PUBLIC_SENTRY_DSN?: string;
      NEXT_PUBLIC_SENTRY_ENVIRONMENT?: string;
      NEXT_PUBLIC_SENTRY_RELEASE?: string;
    };
  }
}

if (typeof window !== 'undefined') {
  FrontendTracer();
  if (window.location) {
    const session = SessionGateway.getSession();
    Sentry.setUser({ id: session.userId, email: session.email });

    // Set context prior to provider init to avoid multiple http calls
    OpenFeature.setContext({ targetingKey: session.userId, ...session }).then(() => {
      /**
       * We connect to flagd through the envoy proxy, straight from the browser,
       * for this we need to know the current hostname and port.
       */

      const useTLS = window.location.protocol === 'https:';
      let port = useTLS ? 443 : 80;
      if (window.location.port) {
          port = parseInt(window.location.port, 10);
      }

      OpenFeature.setProvider(
        new FlagdWebProvider({
          host: window.location.hostname,
          pathPrefix: 'flagservice',
          port: port,
          tls: useTLS,
          maxRetries: 3,
          maxDelay: 10000,
        })
      );
    });

    // When Supabase Auth is configured, keep the session identity in sync with the
    // signed-in user. Anonymous browsing still works when Supabase is disabled.
    const supabase = getSupabase();
    if (supabase) {
      supabase.auth.onAuthStateChange((_event, authSession) => {
        if (authSession?.user) {
          SessionGateway.promoteToUser(authSession.user.id, authSession.user.email ?? undefined);
        } else {
          SessionGateway.demoteToAnonymous();
        }
        const next = SessionGateway.getSession();
        Sentry.setUser({ id: next.userId, email: next.email });
        OpenFeature.setContext({ targetingKey: next.userId, ...next });
        queryClient.invalidateQueries({ queryKey: ['cart'] });
      });
    }
  }
}

const queryClient = new QueryClient();

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <ThemeProvider theme={Theme}>
      <OpenFeatureProvider>
        <QueryClientProvider client={queryClient}>
          <CurrencyProvider>
            <CartProvider>
              <Component {...pageProps} />
            </CartProvider>
          </CurrencyProvider>
        </QueryClientProvider>
      </OpenFeatureProvider>
    </ThemeProvider>
  );
}

MyApp.getInitialProps = async (appContext: AppContext) => {
  const appProps = await App.getInitialProps(appContext);

  return { ...appProps };
};

export default MyApp;
