/**
 * Which deployment this build is for (AMPED-CF-00A).
 *
 * Read at BUILD time from `process.env.AMPED_ENV`, not from the Worker's
 * runtime `AMPED_ENV` var. That is deliberate: four pages are prerendered to
 * static HTML (`export const prerender = true`), so their `<meta robots>` is
 * fixed the moment they are built. A runtime lookup would be ignored by
 * exactly the pages most likely to be crawled.
 *
 * INDEXING IS OPT-IN, AND THE DEFAULT IS "DO NOT INDEX"
 * Staging and production will both serve the same application on public
 * HTTPS. If staging were ever indexed it would duplicate the real site's
 * content under the brand's own name, which is slow to notice and slow to
 * undo. So a build only claims to be indexable when it is told, explicitly,
 * that it is production:
 *
 *     AMPED_ENV=production npm run build
 *
 * The opposite default was considered and rejected. Forgetting the flag on a
 * production build gives a site that is not indexed - visible in one glance
 * at the page source, and fixed by one rebuild. Forgetting it on staging
 * would publish a duplicate of the real site to search engines.
 *
 * Indexing is a courtesy to crawlers, never a security boundary. Cloudflare
 * Access is what actually keeps staging private.
 */

/** `development` | `staging` | `production`. Defaults to the safe one. */
export const DEPLOY_ENV: string =
  (typeof process !== 'undefined' ? process.env?.AMPED_ENV : undefined) ?? 'development';

/** True only for a build explicitly marked production. */
export const IS_PRODUCTION_BUILD: boolean = DEPLOY_ENV === 'production';

/** True when this build may advertise itself to search engines. */
export const IS_INDEXABLE: boolean = IS_PRODUCTION_BUILD;
