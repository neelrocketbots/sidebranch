#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2))
  .then((code) => { if (typeof code === "number" && code !== 0) process.exit(code); })
  .catch((err) => {
    process.stderr.write(`sidebranch: ${err.message}\n`);
    process.exit(1);
  });
