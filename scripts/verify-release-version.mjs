import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function verifyReleaseTagMatchesVersion({ refType, ref, refName, packageVersion }) {
  const isTagRef = refType === "tag" || (typeof ref === "string" && ref.startsWith("refs/tags/"));
  if (!isTagRef) {
    return { checked: false };
  }

  const tagName = refName || (typeof ref === "string" ? ref.slice("refs/tags/".length) : "");
  if (!tagName || typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("Release tag or package.json version is missing; refusing to build a release.");
  }

  const expectedTag = `v${packageVersion}`;
  if (tagName !== expectedTag) {
    throw new Error(`Release tag ${tagName} does not match package.json version ${packageVersion}; expected ${expectedTag}.`);
  }

  return { checked: true, tagName, packageVersion };
}

function main() {
  const repositoryRoot = new URL("../", import.meta.url);
  const packageJson = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8"));
  const result = verifyReleaseTagMatchesVersion({
    refType: process.env.GITHUB_REF_TYPE,
    ref: process.env.GITHUB_REF,
    refName: process.env.GITHUB_REF_NAME,
    packageVersion: packageJson.version,
  });

  if (result.checked) {
    console.log(`Release tag ${result.tagName} matches package.json version ${result.packageVersion}.`);
  } else {
    console.log("Non-tag workflow dispatch; release version check skipped.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
