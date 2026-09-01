#!/usr/bin/env node
import { main } from "../src/cli.js";

// `sidebranch stop | head -1` must not crash on EPIPE when the pipe closes.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });

main(process.argv.slice(2))
  .then((code) => { if (typeof code === "number" && code !== 0) process.exit(code); })
  .catch((err) => {
    process.stderr.write(`sidebranch: ${err.message}\n`);
    process.exit(1);
  });
