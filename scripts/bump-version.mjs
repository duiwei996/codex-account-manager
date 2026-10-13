import { parseVersion, readProjectVersion, synchronizeProjectVersion } from "./project-version.mjs";

try {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: node scripts/bump-version.mjs <version|major|minor|patch>");
  const current = readProjectVersion();
  const parts = parseVersion(current);
  const level = ["major", "minor", "patch"].indexOf(input);
  let next = input;
  if (level >= 0) {
    parts[level] += 1;
    for (let index = level + 1; index < parts.length; index++) parts[index] = 0;
    next = parts.join(".");
  }
  synchronizeProjectVersion(process.cwd(), next);
  console.log(`Version updated: ${current} -> ${next}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
