import { z } from "zod";

export const ControlPlaneConfigSchema = z.object({
  databaseUrl: z.string().url(),
  // Bootstrap only: creates pilots and registers participants. It can never classify a
  // checkpoint or write governance evidence, because those require a bound participant.
  adminTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactEncryptionKeyBase64: z.string().min(1),
  pilotLinkSecret: z.string().min(16),
  publicBaseUrl: z.string().url(),
  githubAppId: z.string().min(1),
  githubPrivateKeyBase64: z.string().min(1),
  githubWebhookSecret: z.string().min(16),
  githubReadyLabel: z.string().min(1).default("roadmapos:ready")
});
export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>;

export function configFromEnv(): ControlPlaneConfig {
  return ControlPlaneConfigSchema.parse({
    databaseUrl: process.env.DATABASE_URL,
    adminTokenSha256: process.env.ADMIN_TOKEN_SHA256,
    artifactEncryptionKeyBase64: process.env.ARTIFACT_ENCRYPTION_KEY_BASE64,
    pilotLinkSecret: process.env.PILOT_LINK_SECRET,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    githubAppId: process.env.GITHUB_APP_ID,
    githubPrivateKeyBase64: process.env.GITHUB_PRIVATE_KEY_BASE64,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    githubReadyLabel: process.env.GITHUB_READY_LABEL
  });
}
