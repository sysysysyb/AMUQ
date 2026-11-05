import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(
  new URL("./update-preview-alias.mjs", import.meta.url),
);
const sha = "a".repeat(40);
const event = {
  action: "vercel.deployment.ready",
  client_payload: {
    environment: "preview",
    project: { id: "prj_test" },
    id: "dpl_test",
    git: { sha, ref: "feature/test" },
  },
};
const preload = `
import assert from "node:assert/strict";
globalThis.fetch = async (url, init) => {
  assert.equal(init.method, "GET");
  if ((process.env.TEST_MODE === "github403" && url.origin === "https://api.github.com") || (process.env.TEST_MODE === "vercel403" && url.origin === "https://api.vercel.com")) {
    return new Response("private-provider-error", {status:403});
  }
  if (process.env.TEST_MODE === "badjson") {
    return new Response("private-provider-error", {status:200});
  }
  if ((process.env.TEST_MODE === "githubConnection" && url.origin === "https://api.github.com") || (process.env.TEST_MODE === "vercelConnection" && url.origin === "https://api.vercel.com")) throw new Error("private-provider-error");
  let data;
  if (url.origin === "https://api.github.com") {
    assert.equal(url.pathname, "/repos/example/amuq/pulls");
    assert.equal(init.headers.Authorization, "Bearer github-fixture");
    const pull = {
      state:"open", draft:false, base:{ref:"main"},
      head:{sha:"a".repeat(40),ref:"feature/test",repo:{full_name:"example/amuq"}}
    };
    data = process.env.TEST_MODE === "ambiguous" ? [pull,pull] : [pull];
  } else {
    assert.equal(init.headers.Authorization, "Bearer vercel-fixture");
    assert.equal(url.origin,"https://api.vercel.com");
    assert.equal(url.searchParams.get("teamId"),"team_test");
    if (url.pathname === "/v13/deployments/dpl_test") {
      data = {
        id:"dpl_test",projectId:"prj_test",readyState:"READY",target:null,createdAt:100,
        meta:{githubCommitSha:"a".repeat(40),githubCommitRef:"feature/test",githubRepoId:"123"}
      };
    } else {
      assert.equal(url.pathname,"/v4/aliases/test-preview.vercel.app");
      data = {alias:"test-preview.vercel.app",projectId:"prj_test",deploymentId:"dpl_test"};
    }
  }
  return Response.json(data);
};
`;

test("CLI reads Actions environment and reports safe, actionable failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "amuq-preview-alias-"));
  try {
    const eventPath = join(directory, "event.json");
    const preloadPath = join(directory, "preload.mjs");
    await writeFile(eventPath, JSON.stringify(event));
    await writeFile(preloadPath, preload);
    for (const [mode, status, expected] of [
      ["normal", 0, /"status":"unchanged"/],
      ["ambiguous", 1, /Multiple PRs/],
      ["github403", 1, /GitHub API returned HTTP 403/],
      ["vercel403", 1, /Vercel API returned HTTP 403/],
      ["githubConnection", 1, /GitHub API connection failed/],
      ["vercelConnection", 1, /Vercel API connection failed/],
      ["badjson", 1, /Preview alias update failed/],
    ]) {
      await t.test(mode, () => {
        const result = spawnSync(
          process.execPath,
          ["--import", pathToFileURL(preloadPath).href, script],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 10_000,
            env: {
              ...process.env,
              GITHUB_EVENT_PATH: eventPath,
              GITHUB_REPOSITORY: "example/amuq",
              GITHUB_REPOSITORY_ID: "123",
              VERCEL_PROJECT_ID: "prj_test",
              VERCEL_TEAM_ID: "team_test",
              PREVIEW_ALIAS: "test-preview.vercel.app",
              GH_TOKEN: "github-fixture",
              VERCEL_TOKEN: "vercel-fixture",
              TEST_MODE: mode,
            },
          },
        );
        assert.equal(result.status, status);
        const output = result.stdout + result.stderr;
        assert.match(output, expected);
        assert.doesNotMatch(
          output,
          /private-provider-error|github-fixture|vercel-fixture/,
        );
      });
    }
  } finally {
    const target = await realpath(directory);
    assert.equal(dirname(target), await realpath(tmpdir()));
    assert.ok(basename(target).startsWith("amuq-preview-alias-"));
    await rm(target, { recursive: true, force: true });
  }
});
