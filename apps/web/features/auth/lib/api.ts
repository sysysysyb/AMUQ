export const postJson = (path: string, body: Record<string, unknown>) => {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};

export const fetchAccountLinkStatus = () => {
  return fetch("/api/auth/link/status", { cache: "no-store" });
};
