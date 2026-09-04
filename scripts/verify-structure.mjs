import { existsSync } from "node:fs";
import { resolve } from "node:path";

const requiredDirectories = ["extension", "server", "docs", "tests"];
const missing = requiredDirectories.filter(
  (directory) => !existsSync(resolve(process.cwd(), directory)),
);

if (missing.length > 0) {
  console.error(`Missing required monorepo directories: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("PrivAgent monorepo structure is valid.");
