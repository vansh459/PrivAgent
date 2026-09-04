import { existsSync } from "node:fs";
import { join } from "node:path";

const candidates = process.platform === "win32"
  ? [join("server", ".venv", "Scripts", "python.exe"), "python"]
  : [join("server", ".venv", "bin", "python"), "python3", "python"];

export function serverPython() {
  return candidates.find((candidate) => candidate === "python" || candidate === "python3" || existsSync(candidate));
}
