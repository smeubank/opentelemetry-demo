// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

/*
 * Images are served through the same frontend-proxy origin as the application.
 * Return the same relative URL during SSR and client rendering so the generated
 * image attributes remain stable during hydration.
 */
export default function imageLoader({ src, width, quality }) {
  // When Supabase Storage is configured, serve product images from the public
  // bucket instead of the bundled image-provider. Matches getProductImageUrl().
  const base =
    typeof window !== 'undefined' && window.ENV
      ? window.ENV.NEXT_PUBLIC_SUPABASE_STORAGE_BASE_URL
      : process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BASE_URL || process.env.SUPABASE_STORAGE_BASE_URL;
  const product = src.match(/\/images\/products\/(.+)$/);
  if (base && product) {
    return `${base.replace(/\/+$/, '')}/${product[1]}`;
  }

  const normalizedSrc = `/${src.replace(/^\/+/, '')}`;
  return `${normalizedSrc}?w=${width}&q=${quality || 75}`;
}
