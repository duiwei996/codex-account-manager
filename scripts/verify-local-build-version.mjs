import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { verifyProjectVersion } from "./project-version.mjs";

export function verifyLocalBuildVersion(version, installedVersions) {
  const parse = value => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Invalid version: ${value}`);
    return value.split(".").map(Number);
  };
  const source = parse(version);
  for (const installed of installedVersions) {
    const parts = parse(installed);
    const different = parts.findIndex((value, index) => value !== source[index]);
    if (different >= 0 && parts[different] > source[different]) {
      throw new Error(`Source version ${version} is older than installed version ${installed}. Bump the version before building a new installer.`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.platform === "win32") {
  const version = verifyProjectVersion(fileURLToPath(new URL("..", import.meta.url)));
  const installed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-File", fileURLToPath(new URL("get-installed-windows-versions.ps1", import.meta.url))], { encoding: "utf8", windowsHide: true, timeout: 15_000 }).trim());
  verifyLocalBuildVersion(version, installed);
  console.log(`Local installer version verified: ${version}`);
}
