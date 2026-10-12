import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function createDraftRelease({ version, repository, ref, commit }, request) {
  if (repository !== "duiwei996/codex-account-manager" || ref !== "refs/heads/main") {
    throw new Error("Release creation is restricted to this project's main branch");
  }
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Invalid release version or source commit");
  }
  const payload = {
    tag_name: `v${version}`,
    target_commitish: commit,
    name: `Codex 账号管理器 v${version}`,
    body: "正式版安装包及签名自动更新文件。Windows 使用 setup.exe，macOS 使用 dmg，Linux 使用 AppImage、deb 或 rpm。macOS 使用免费临时签名，未经 Apple 公证，首次打开可能需要在隐私与安全性中手动放行。",
    draft: true,
    prerelease: false,
  };
  // A new draft may have an untagged URL and cannot be resolved by the tag endpoint.
  const release = request(`repos/${repository}/releases`, payload);
  if (!Number.isSafeInteger(release?.id) || release.id <= 0 || release.draft !== true ||
      release.tag_name !== payload.tag_name || release.target_commitish !== commit) {
    throw new Error("Created draft release does not match the requested version and commit");
  }
  return release.id;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("Missing GitHub Actions output file");
  const id = createDraftRelease({
    version: process.argv[2],
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    commit: process.env.GITHUB_SHA,
  }, (endpoint, payload) => JSON.parse(execFileSync("gh", ["api", "--method", "POST", endpoint, "--input", "-"], {
    input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "inherit"],
  })));
  appendFileSync(process.env.GITHUB_OUTPUT, `release-id=${id}\n`);
  console.log(`Created and validated shared draft release ${id}.`);
}
