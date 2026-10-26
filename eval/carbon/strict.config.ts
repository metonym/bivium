import { defineConfig } from "../../src/index.ts";
import carbon from "./bivium.config.ts";

/**
 * `bivium.config.ts` with barrel binding limited to the package entry, as
 * carbon's selector does. Replaying it isolates the one generalization that
 * changes plans: binding names of every barrel (see docs/decisions.md).
 */
export default defineConfig({ ...carbon, barrels: ["src/index.{js,d.ts}"] });
