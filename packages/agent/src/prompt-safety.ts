const credentialPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:GITHUB_TOKEN|OPENAI_API_KEY|DATABASE_URL|ARTIFACT_ENCRYPTION_KEY_BASE64)\s*=/
];

export function assertPromptSafe(text: string): void {
  if (Buffer.byteLength(text, "utf8") > 1_500_000) throw new Error("Agent input exceeds 1.5 MB");
  if (credentialPatterns.some((pattern) => pattern.test(text))) {
    throw new Error("Agent input contains credential-like material");
  }
}
