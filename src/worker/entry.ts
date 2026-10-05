/**
 * Custom Worker entrypoint (AMPED-06B).
 *
 * The accepted @astrojs/cloudflare adapter entry exports only `fetch`, so a
 * scheduled handler cannot be attached there. This wrapper adds one, using the
 * adapter's supported public handler (`@astrojs/cloudflare/handler`) rather
 * than any package-internal path.
 *
 * It is deliberately tiny: fetch delegates straight to Astro (so middleware,
 * Access protection and every route behave exactly as before), and scheduled
 * only forwards to the orchestration module. No SQL, no routing and no second
 * service container live here.
 */

import { handle } from '@astrojs/cloudflare/handler';

import { runScheduledTasks } from './scheduled.ts';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  },

  scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext) {
    // The platform event time is the authoritative clock for the sweep.
    const scheduledAt = new Date(controller.scheduledTime);
    ctx.waitUntil(runScheduledTasks(scheduledAt).then((summary) => {
      // Counts only: enough to certify each hosted pass without logging an
      // order reference, buyer detail, provider response or credential.
      console.info(JSON.stringify({
        at: 'amped-scheduled',
        scheduledAt: scheduledAt.toISOString(),
        reconciliation: summary.reconciliation,
        expired: summary.expired,
        discrepancies: summary.discrepancies,
      }));
    }));
  },
} satisfies ExportedHandler<Env>;
