// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { readPublicEnv } from './supabase';

/**
 * Resolves a product image URL. When NEXT_PUBLIC_SUPABASE_STORAGE_BASE_URL is
 * set, images are served from the Supabase Storage public bucket; otherwise they
 * fall back to the bundled image-provider served under /images/products/.
 * Returns the same value on the server and the client so hydration stays stable.
 */
export function getProductImageUrl(picture?: string): string {
  if (!picture) return '';
  const file = picture.replace(/^\/+/, '');
  const base = readPublicEnv('NEXT_PUBLIC_SUPABASE_STORAGE_BASE_URL');
  if (base) return `${base.replace(/\/+$/, '')}/${file}`;
  return `/images/products/${file}`;
}

/** True when product images are served from Supabase Storage. */
export function isSupabaseStorageEnabled(): boolean {
  return Boolean(readPublicEnv('NEXT_PUBLIC_SUPABASE_STORAGE_BASE_URL'));
}
