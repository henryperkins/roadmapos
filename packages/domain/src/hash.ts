import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}
