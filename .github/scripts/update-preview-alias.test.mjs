import assert from "node:assert/strict";
import test from "node:test";

import { updatePreviewAlias } from "./update-preview-alias.mjs";

const repository = "example/amuq";
const sha = "a".repeat(40);
const branch = "refactor/27-rename-app-directories";
const alias = "amuq-auth-preview-example.vercel.app";
const deploymentId = "dpl_new";
const config = {
  repository,
  repositoryId: "123",
  projectId: "prj_amuq",
  teamId: "team_amuq",
  alias,
  githubToken: "github-test-token",
  vercelToken: "vercel-test-token",
};
const event = {
  action: "vercel.deployment.ready",
  client_payload: {
    environment: "preview",
    project: { id: config.projectId },
    id: deploymentId,
    git: { sha, ref: branch },
  },
};
const pull = {
  state: "open",
  draft: false,
  base: { ref: "main" },
  head: { sha, ref: branch, repo: { full_name: repository } },
};
const deployment = {
  id: deploymentId,
  projectId: config.projectId,
  readyState: "READY",
  target: null,
  createdAt: 200,
  meta: {
    githubCommitSha: sha,
    githubCommitRef: branch,
    githubRepoId: "123",
  },
};

const setup = (overrides = {}) => {
  const state = {
    pulls: [structuredClone(pull)],
    deployment: structuredClone(deployment),
    old: {
      id: "dpl_old",
      projectId: config.projectId,
      target: null,
      createdAt: 100,
    },
    alias: { alias, projectId: config.projectId, deploymentId: "dpl_old" },
    ...overrides,
  };
  const requests = [];
  let pullReads = 0;
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, ...init });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(url.searchParams.has("token"), false);
    let data;
    if (url.origin === "https://api.github.com") {
      assert.equal(init.headers.Authorization, "Bearer github-test-token");
      assert.equal(url.pathname, "/repos/example/amuq/pulls");
      assert.equal(url.searchParams.get("state"), "open");
      assert.equal(url.searchParams.get("base"), "main");
      pullReads++;
      data =
        pullReads > 1 && state.refreshedPulls
          ? state.refreshedPulls
          : state.pulls;
    } else {
      assert.equal(url.origin, "https://api.vercel.com");
      assert.equal(url.searchParams.get("teamId"), config.teamId);
      assert.equal(init.headers.Authorization, "Bearer vercel-test-token");
      if (url.pathname === "/v13/deployments/dpl_new") data = state.deployment;
      else if (url.pathname === "/v13/deployments/dpl_old") data = state.old;
      else if (url.pathname === "/v4/aliases/" + alias) data = state.alias;
      else if (url.pathname === "/v2/deployments/dpl_new/aliases") {
        assert.equal(init.method, "POST");
        assert.deepEqual(JSON.parse(init.body), { alias });
        state.alias.deploymentId = state.afterWriteId ?? deploymentId;
        data = { alias };
      } else assert.fail("Unexpected API path");
    }
    return new Response(JSON.stringify(data), {
      status: state.httpStatus ?? 200,
    });
  };
  return {
    requests,
    state,
    run: (changes = {}) =>
      updatePreviewAlias({
        ...config,
        event: structuredClone(event),
        fetchImpl,
        ...changes,
      }),
  };
};

test("links the latest PR Preview after checking Vercel and refreshing the PR", async () => {
  const context = setup();
  assert.deepEqual(await context.run(), { status: "updated", sha });
  const writes = context.requests.filter(
    (request) => request.method === "POST",
  );
  assert.equal(writes.length, 1);
  const beforeWrite = context.requests.slice(
    0,
    context.requests.indexOf(writes[0]),
  );
  assert.equal(
    beforeWrite.filter((r) => r.url.origin === "https://api.github.com").length,
    2,
  );
  assert.equal(context.requests.at(-1).url.pathname, "/v4/aliases/" + alias);
});

test("ignores unrelated events without making API requests", async (t) => {
  for (const change of [
    { action: "vercel.deployment.error" },
    { client_payload: { ...event.client_payload, environment: "production" } },
    {
      client_payload: { ...event.client_payload, project: { id: "prj_other" } },
    },
  ]) {
    await t.test(JSON.stringify(change), async () => {
      const context = setup();
      assert.equal(
        (await context.run({ event: { ...event, ...change } })).status,
        "skipped",
      );
      assert.equal(context.requests.length, 0);
    });
  }
});

test("does not link ineligible or stale pull requests", async (t) => {
  for (const candidate of [
    null,
    { ...pull, state: "closed" },
    { ...pull, draft: true },
    { ...pull, base: { ref: "develop" } },
    { ...pull, head: { ...pull.head, repo: { full_name: "fork/amuq" } } },
    { ...pull, head: { ...pull.head, sha: "b".repeat(40) } },
    { ...pull, head: { ...pull.head, ref: "other-branch" } },
  ]) {
    await t.test(JSON.stringify(candidate), async () => {
      const context = setup({ pulls: candidate ? [candidate] : [] });
      assert.equal((await context.run()).status, "skipped");
      assert.equal(
        context.requests.some((r) => r.method === "POST"),
        false,
      );
    });
  }
});

test("refuses ambiguous PR selection", async () => {
  const context = setup({
    pulls: [pull, { ...pull, head: { ...pull.head, ref: "other" } }],
  });
  await assert.rejects(context.run(), /Multiple PRs/);
  assert.equal(
    context.requests.some((r) => r.method === "POST"),
    false,
  );
});

test("refuses an incomplete 100-PR listing even with one eligible PR", async () => {
  const context = setup({
    pulls: [
      ...Array.from({ length: 99 }, () => ({ ...pull, draft: true })),
      pull,
    ],
  });
  await assert.rejects(context.run(), /complete open PR selection/);
  assert.equal(
    context.requests.some((r) => r.method === "POST"),
    false,
  );
});

test("verifies deployment identity, readiness, Preview target and Git metadata", async (t) => {
  for (const change of [
    { id: "dpl_other" },
    { projectId: "prj_other" },
    { readyState: "BUILDING" },
    { target: "production" },
    { target: "staging" },
    { createdAt: null },
    { meta: { ...deployment.meta, githubCommitSha: "b".repeat(40) } },
    { meta: { ...deployment.meta, githubCommitRef: "other" } },
    { meta: { ...deployment.meta, githubRepoId: "456" } },
  ]) {
    await t.test(JSON.stringify(change), async () => {
      const context = setup({ deployment: { ...deployment, ...change } });
      await assert.rejects(context.run(), /Deployment does not match/);
      assert.equal(
        context.requests.some((r) => r.method === "POST"),
        false,
      );
    });
  }
});

test("refuses to take over an alias belonging to another project or Production", async () => {
  for (const change of [
    { alias: { alias, projectId: "prj_other", deploymentId: "dpl_old" } },
    { old: { ...deployment, id: "dpl_old", target: "production" } },
  ]) {
    const context = setup(change);
    await assert.rejects(context.run(), /different project|Refusing to move/);
    assert.equal(
      context.requests.some((r) => r.method === "POST"),
      false,
    );
  }
});

test("allows takeover from an older PR even if that Preview was created later", async () => {
  const context = setup({
    old: {
      ...deployment,
      id: "dpl_old",
      createdAt: 300,
      meta: { githubCommitRef: "feature/previous-pr" },
    },
  });
  assert.equal((await context.run()).status, "updated");
});

test("repeated events are idempotent and older redeployments cannot roll back the alias", async () => {
  const context = setup();
  assert.equal((await context.run()).status, "updated");
  assert.equal((await context.run()).status, "unchanged");
  assert.equal(context.requests.filter((r) => r.method === "POST").length, 1);
  const newer = setup({
    old: { ...deployment, id: "dpl_old", createdAt: 300 },
  });
  assert.deepEqual(await newer.run(), {
    status: "skipped",
    reason: "newer-deployment-already-linked",
  });
  assert.equal(
    newer.requests.some((r) => r.method === "POST"),
    false,
  );
});

test("returns a specific skip if the PR changes immediately before update", async () => {
  const context = setup({
    refreshedPulls: [{ ...pull, head: { ...pull.head, sha: "b".repeat(40) } }],
  });
  assert.deepEqual(await context.run(), {
    status: "skipped",
    reason: "pr-changed-before-update",
  });
  assert.equal(
    context.requests.some((r) => r.method === "POST"),
    false,
  );
});

test("rejects ambiguous PR selection immediately before update", async () => {
  const context = setup({
    refreshedPulls: [pull, { ...pull, head: { ...pull.head, ref: "other" } }],
  });
  await assert.rejects(context.run(), /Multiple PRs/);
  assert.equal(
    context.requests.some((r) => r.method === "POST"),
    false,
  );
});

test("rejects malformed current aliases and previous deployment metadata", async () => {
  for (const changes of [
    {
      alias: {
        alias: "different.vercel.app",
        projectId: config.projectId,
        deploymentId: "dpl_old",
      },
    },
    { alias: { alias, projectId: config.projectId, deploymentId: null } },
    {
      alias: { alias, projectId: config.projectId, deploymentId: "../invalid" },
    },
    { old: { ...deployment, id: "dpl_old", projectId: "prj_other" } },
    { old: { ...deployment, id: "dpl_old", createdAt: null } },
  ]) {
    const context = setup(changes);
    await assert.rejects(context.run(), /Fixed Preview alias|Refusing to move/);
    assert.equal(
      context.requests.some((r) => r.method === "POST"),
      false,
    );
  }
});

test("fails closed on malformed events, missing configuration and upstream errors", async () => {
  for (const changes of [
    { vercelToken: "" },
    { alias: "production.example.com" },
    {
      event: {
        ...event,
        client_payload: { ...event.client_payload, id: "../malicious" },
      },
    },
  ]) {
    const context = setup();
    await assert.rejects(context.run(changes), /Missing or invalid/);
    assert.equal(context.requests.length, 0);
  }
  const context = setup({ httpStatus: 401 });
  await assert.rejects(context.run(), /GitHub API returned HTTP 401/);
  assert.equal(
    context.requests.some((r) => r.method === "POST"),
    false,
  );
});

test("detects a failed post-update alias verification", async () => {
  const context = setup({ afterWriteId: "dpl_unexpected" });
  await assert.rejects(context.run(), /Alias verification failed/);
});
