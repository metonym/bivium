import { defineConfig } from "../../src/index.ts";
import phase0 from "./phase0.config.ts";

/** `phase0.config.ts` with barrel binding limited to the package entry. */
export default defineConfig({ ...phase0, barrels: ["src/index.{js,d.ts}"] });
