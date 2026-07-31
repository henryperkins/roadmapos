import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OctokitGitHubGateway } from "../src/index.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface StubRoute { status: number; body: unknown }

const routes = new Map<string, StubRoute>();
const requestedPaths: string[] = [];
const realFetch = globalThis.fetch;

function requestUrl(input: FetchInput): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const installationToken = {
  token: "ghs_installation_token",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  permissions: {},
  repository_selection: "all"
};

function installFetch(handler: (url: URL, init: FetchInit) => Response): void {
  globalThis.fetch = vi.fn((input: FetchInput, init?: FetchInit) => Promise.resolve(handler(requestUrl(input), init)));
}

beforeEach(() => {
  routes.clear();
  requestedPaths.length = 0;
  routes.set("POST /app/installations/55/access_tokens", { status: 201, body: installationToken });
  installFetch((url, init) => {
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    requestedPaths.push(key);
    const route = routes.get(key);
    return route ? json(route.body, route.status) : json({ message: "Not Found" }, 404);
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function gateway(): OctokitGitHubGateway {
  return new OctokitGitHubGateway("12345", privateKey);
}

describe("OctokitGitHubGateway", () => {
  it("mints an installation token rather than exposing app credentials", async () => {
    expect(await gateway().createInstallationToken("55")).toBe("ghs_installation_token");
    expect(requestedPaths).toContain("POST /app/installations/55/access_tokens");
  });

  it("returns a known repository permission", async () => {
    routes.set("GET /repos/acme/widget/collaborators/maintainer/permission", { status: 200, body: { permission: "maintain", user: { login: "maintainer" } } });
    const permission = await gateway().getRepositoryPermission({ installationId: "55", owner: "acme", repo: "widget", login: "maintainer" });
    expect(permission).toBe("maintain");
  });

  it("rejects a permission value outside the supported set", async () => {
    routes.set("GET /repos/acme/widget/collaborators/maintainer/permission", { status: 200, body: { permission: "owner", user: { login: "maintainer" } } });
    await expect(gateway().getRepositoryPermission({ installationId: "55", owner: "acme", repo: "widget", login: "maintainer" }))
      .rejects.toThrow("Unsupported GitHub permission: owner");
  });

  it("opens pull requests as drafts only", async () => {
    let sentBody: Record<string, unknown> = {};
    installFetch((url, init) => {
      if (url.pathname === "/app/installations/55/access_tokens") return json(installationToken, 201);
      sentBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      return json({ id: 900, number: 12, node_id: "PR_12", html_url: "https://github.test/pull/12" }, 201);
    });

    const created = await gateway().openDraftPullRequest({ installationId: "55", owner: "acme", repo: "widget", base: "main", head: "roadmapos/run", title: "T", body: "B" });
    expect(sentBody.draft).toBe(true);
    expect(created).toEqual({ id: "900", number: 12, nodeId: "PR_12", url: "https://github.test/pull/12" });
  });

  it("treats a missing branch protection as absent instead of failing", async () => {
    const record = await gateway().getBranchProtection({ installationId: "55", owner: "acme", repo: "widget", branch: "main" });
    expect(record).toEqual({ enabled: false, requiredApprovals: 0 });
  });

  it("decodes file contents and rejects a directory", async () => {
    routes.set("GET /repos/acme/widget/contents/README.md", {
      status: 200,
      body: { type: "file", encoding: "base64", content: Buffer.from("hello", "utf8").toString("base64"), path: "README.md" }
    });
    expect(await gateway().getFile({ installationId: "55", owner: "acme", repo: "widget", path: "README.md", ref: "a".repeat(40) })).toBe("hello");

    routes.set("GET /repos/acme/widget/contents/src", { status: 200, body: [{ type: "file", path: "src/a.ts" }] });
    await expect(gateway().getFile({ installationId: "55", owner: "acme", repo: "widget", path: "src", ref: "a".repeat(40) }))
      .rejects.toThrow("GitHub path is not a file: src");
  });
});
