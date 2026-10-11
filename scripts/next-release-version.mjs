import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function nextReleaseVersion(base, tags) {
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) return null;
    const parts = match.slice(1).map(Number);
    if (parts.some(n => !Number.isSafeInteger(n) || n > 4294967295)) throw new Error("Invalid version number");
    return parts;
  };
  let highest = parse(base);
  if (!highest) throw new Error("Invalid project version");
  let baseAlreadyReserved = false;
  for (const tag of tags) {
    if (!tag.startsWith("v")) continue;
    const candidate = parse(tag.slice(1));
    if (!candidate) continue;
    const difference = candidate.findIndex((n, i) => n !== highest[i]);
    if (difference === -1 || (difference >= 0 && candidate[difference] > highest[difference])) baseAlreadyReserved = true;
    if (difference >= 0 && candidate[difference] > highest[difference]) highest = candidate;
  }
  if (!baseAlreadyReserved) return base;
  if (highest[2] === 4294967295) throw new Error("Patch version overflow");
  return `${highest[0]}.${highest[1]}.${highest[2] + 1}`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const base = JSON.parse(readFileSync("package.json", "utf8")).version;
  const tags = readFileSync(process.argv[2], "utf8").split(/\r?\n/);
  console.log(nextReleaseVersion(base, tags));
}
