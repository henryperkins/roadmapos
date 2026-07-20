import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

export interface SealedArtifact {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class SecretBox {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    this.#key = Buffer.from(base64Key, "base64");
    if (this.#key.length !== 32) {
      throw new Error("ARTIFACT_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
    }
  }

  seal(value: unknown, associatedData: string): SealedArtifact {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(canonicalJson(value), "utf8"),
      cipher.final()
    ]);
    return {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  }

  // The generic return is the published `SecretBox.open<T>` contract in the master interface map;
  // callers assert the sealed payload shape at the call site.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  open<T>(artifact: SealedArtifact, associatedData: string): T {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(artifact.iv, "base64"));
      decipher.setAAD(Buffer.from(associatedData, "utf8"));
      decipher.setAuthTag(Buffer.from(artifact.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(artifact.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");
      return JSON.parse(plaintext) as T;
    } catch {
      throw new Error("Unable to decrypt artifact");
    }
  }
}
