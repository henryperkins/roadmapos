interface ControlPlaneCredentials { baseUrl: string; token: string }

/**
 * Resolved on first use rather than at module load: a build step that never calls the control
 * plane must not need operator credentials, but a request that does must fail loudly instead of
 * falling back to a default endpoint or an anonymous call.
 */
function credentials(): ControlPlaneCredentials {
  const baseUrl = process.env.CONTROL_PLANE_INTERNAL_URL;
  const token = process.env.CONTROL_PLANE_OPERATOR_TOKEN;
  if (!baseUrl || !token) throw new Error("CONTROL_PLANE_INTERNAL_URL and CONTROL_PLANE_OPERATOR_TOKEN are required");
  return { baseUrl, token };
}

export async function controlPlane<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl, token } = credentials();
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, cache: "no-store" });
  if (!response.ok) throw new Error(`Control plane returned ${String(response.status)}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
