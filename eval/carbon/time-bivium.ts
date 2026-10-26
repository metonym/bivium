/**
 * One timed bivium plan, in-process, as Phase 0 timed carbon's selector:
 * from the start of planning to the plan, after modules and config load.
 *
 *   bun eval/carbon/time-bivium.ts <clone> <base> [<cache dir> | --no-cache]
 *
 * Without a third argument, the cache is wherever the config puts it.
 */
import { loadavg } from "node:os";
import { computePlan } from "../../src/compute.ts";
import { loadConfig } from "../../src/config.ts";

const [clone, base, cacheArg] = process.argv.slice(2);
const cache = cacheArg === "--no-cache" ? false : cacheArg;
const c0 = performance.now();
const { config } = await loadConfig(
  clone,
  `${import.meta.dir}/bivium.config.ts`,
);
const t0 = performance.now();
const { plan, extracted } = await computePlan(clone, base, config, {
  ...(cache !== undefined && { cache }),
});
const ms = performance.now() - t0;
console.log(
  JSON.stringify({
    selectorMs: ms,
    configMs: t0 - c0,
    load: loadavg()[0],
    unit: plan.suites.unit.mode,
    e2e: plan.suites.e2e.mode,
    extracted,
  }),
);
