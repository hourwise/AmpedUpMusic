// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

/**
 * Amped Up Music Promotions — Astro configuration.
 *
 * Target runtime is Cloudflare Workers with Static Assets (see Docs/ build plan).
 * `output: 'server'` is the default; genuinely static pages opt in with
 * `export const prerender = true` at the top of the page. During AMPED-01 the
 * whole site renders from in-memory fixtures, so prerendering is used wherever
 * the page will still be static once D1 lands (legal/info pages).
 */
export default defineConfig({
  // The live zone. `ampedupmusic.co.uk` (no "promo") was never registered -
  // it was a typo that disagreed with CANONICAL_ORIGIN in src/lib/seo.ts.
  site: 'https://ampedupmusicpromo.co.uk',
  output: 'server',
  // AMPED-CF-00A: no page uses Astro.session, and leaving it on makes the
  // adapter emit a `SESSION` KV binding with no namespace id - which a real
  // `wrangler deploy` rejects. Rather than invent a throwaway namespace to
  // satisfy a facility nothing uses, the facility is turned off. Switch this
  // back on, with a real KV namespace, if sessions are ever actually needed.
  session: false,
  adapter: cloudflare({
    // AMPED-01 ships its own self-contained SVG artwork, so no Cloudflare
    // Images binding is required yet. AMPED-05A should revisit this once real
    // photographs are uploaded to R2 (likely `{ build: 'compile', runtime:
    // 'cloudflare-binding' }` with an IMAGES binding declared in wrangler.jsonc).
    imageService: 'passthrough',
  }),
  compressHTML: true,
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  devToolbar: { enabled: false },
});
