import console from "node:console";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

class PreviewAliasError extends Error {}

export const updatePreviewAlias = async ({
  event,
  repository,
  repositoryId,
  projectId,
  teamId,
  alias,
  githubToken,
  vercelToken,
  fetchImpl = fetch,
}) => {
  const payload = event.client_payload;
  if (
    event.action !== "vercel.deployment.ready" ||
    payload?.environment !== "preview" ||
    payload?.project?.id !== projectId
  ) {
    return { status: "skipped", reason: "unrelated-deployment" };
  }
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
    !/^\d+$/.test(repositoryId ?? "") ||
    !/^prj_[\w]+$/.test(projectId ?? "") ||
    !/^team_[\w]+$/.test(teamId ?? "") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(alias ?? "") ||
    !githubToken ||
    !vercelToken ||
    !/^dpl_[\w]+$/.test(payload.id ?? "") ||
    !/^[a-f0-9]{40}$/.test(payload.git?.sha ?? "") ||
    typeof payload.git?.ref !== "string"
  ) {
    throw new PreviewAliasError(
      "Missing or invalid Preview alias configuration or event",
    );
  }
  const { sha, ref } = payload.git;
  const request = async (origin, path, token, body) => {
    const provider = origin === "https://api.vercel.com" ? "Vercel" : "GitHub";
    const url = new URL(path, origin);
    if (origin === "https://api.vercel.com")
      url.searchParams.set("teamId", teamId);
    let response;
    try {
      response = await fetchImpl(url, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PreviewAliasError(`${provider} API connection failed`);
    }
    if (!response.ok)
      throw new PreviewAliasError(
        `${provider} API returned HTTP ${response.status}`,
      );
    return response.json();
  };
  const github = (path) => request("https://api.github.com", path, githubToken);
  const vercel = (path, body) =>
    request("https://api.vercel.com", path, vercelToken, body);
  const selectPull = async () => {
    const pulls = await github(
      `/repos/${repository}/pulls?state=open&base=main&per_page=100`,
    );
    if (!Array.isArray(pulls) || pulls.length >= 100) {
      throw new PreviewAliasError(
        "Cannot establish a complete open PR selection",
      );
    }
    const eligible = pulls.filter(
      (pull) =>
        pull.state === "open" &&
        !pull.draft &&
        pull.base?.ref === "main" &&
        pull.head?.repo?.full_name === repository,
    );
    if (eligible.length > 1)
      throw new PreviewAliasError(
        "Multiple PRs would share the fixed Preview alias",
      );
    const selected = eligible[0];
    return selected?.head?.sha === sha && selected?.head?.ref === ref;
  };
  if (!(await selectPull()))
    return { status: "skipped", reason: "not-current-pr-head" };

  const deployment = await vercel(`/v13/deployments/${payload.id}`);
  if (
    deployment.id !== payload.id ||
    deployment.projectId !== projectId ||
    deployment.readyState !== "READY" ||
    deployment.target !== null ||
    !Number.isFinite(deployment.createdAt) ||
    deployment.meta?.githubCommitSha !== sha ||
    deployment.meta?.githubCommitRef !== ref ||
    String(deployment.meta?.githubRepoId) !== repositoryId
  ) {
    throw new PreviewAliasError(
      "Deployment does not match the current repository Preview",
    );
  }
  const aliasPath = `/v4/aliases/${alias}`;
  const current = await vercel(aliasPath);
  if (current.projectId !== projectId || current.alias !== alias) {
    throw new PreviewAliasError(
      "Fixed Preview alias belongs to a different project",
    );
  }
  if (current.deploymentId === deployment.id)
    return { status: "unchanged", sha };
  if (!/^dpl_[\w]+$/.test(current.deploymentId ?? "")) {
    throw new PreviewAliasError("Fixed Preview alias has no valid deployment");
  }
  const previous = await vercel(`/v13/deployments/${current.deploymentId}`);
  if (
    previous.projectId !== projectId ||
    previous.target !== null ||
    !Number.isFinite(previous.createdAt)
  ) {
    throw new PreviewAliasError(
      "Refusing to move an alias outside the project Preview environment",
    );
  }
  if (
    previous.meta?.githubCommitRef === ref &&
    previous.createdAt > deployment.createdAt
  ) {
    return { status: "skipped", reason: "newer-deployment-already-linked" };
  }
  // Recheck after API reads: a newer push or another PR may have arrived meanwhile.
  if (!(await selectPull()))
    return { status: "skipped", reason: "pr-changed-before-update" };
  await vercel(`/v2/deployments/${deployment.id}/aliases`, { alias });
  const linked = await vercel(aliasPath);
  if (linked.deploymentId !== deployment.id || linked.projectId !== projectId) {
    throw new PreviewAliasError("Alias verification failed after update");
  }
  return { status: "updated", sha };
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await updatePreviewAlias({
      event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")),
      repository: process.env.GITHUB_REPOSITORY,
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
      teamId: process.env.VERCEL_TEAM_ID,
      alias: process.env.PREVIEW_ALIAS,
      githubToken: process.env.GH_TOKEN,
      vercelToken: process.env.VERCEL_TOKEN,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      error instanceof PreviewAliasError
        ? error.message
        : "Preview alias update failed. Check configuration, PR selection and API access.",
    );
    process.exitCode = 1;
  }
}
