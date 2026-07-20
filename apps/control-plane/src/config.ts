import { z } from "zod";

export const ControlPlaneConfigSchema = z.object({
  databaseUrl: z.string().url(),
  operatorTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  auditorTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactEncryptionKeyBase64: z.string().min(1),
  pilotLinkSecret: z.string().min(16),
  publicBaseUrl: z.string().url()
});
export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>;

export function configFromEnv(): ControlPlaneConfig {
  return ControlPlaneConfigSchema.parse({
    databaseUrl: process.env.DATABASE_URL,
    operatorTokenSha256: process.env.OPERATOR_TOKEN_SHA256,
    auditorTokenSha256: process.env.AUDITOR_TOKEN_SHA256,
    artifactEncryptionKeyBase64: process.env.ARTIFACT_ENCRYPTION_KEY_BASE64,
    pilotLinkSecret: process.env.PILOT_LINK_SECRET,
    publicBaseUrl: process.env.PUBLIC_BASE_URL
  });
}
