#!/usr/bin/env node
import { environment } from "./env.ts";
import { type Io, main } from "./main.ts";

const io: Io = {
  stdout: process.stdout.isTTY === true,
  stderr: process.stderr.isTTY === true,
  env: environment(),
  writeError: (text) => process.stderr.write(text),
};
process.exitCode = await main(process.argv.slice(2), io);
