import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseVersion, verifyProjectVersion } from "./project-version.mjs";

// Select only the explicitly requested VERSION; never invent a release number.
export function nextReleaseVersion(base, tags) {
  const requested = parseVersion(base);
  let used = false;
  for (const tag of tags) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue;
    const candidate = parseVersion(tag.slice(1));
    const difference = candidate.findIndex((part, index) => part !== requested[index]);
    if (difference >= 0 && candidate[difference] > requested[difference]) throw new Error(`VERSION ${base} is older than existing ${tag}. Set the intended release version explicitly.`);
    if (difference === -1) used = true;
  }
  return used ? null : base;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const version = verifyProjectVersion();
    const tags = readFileSync(process.argv[2], "utf8").split(/\r?\n/);
    console.log(nextReleaseVersion(version, tags) ?? "");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
