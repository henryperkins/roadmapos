"use server";
import { redirect } from "next/navigation";
import { controlPlane } from "../../../../lib/control-plane";

/** A form field is a string or an uploaded file; this gate keeps a file from being stringified. */
function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function lines(value: FormDataEntryValue | null): string[] {
  return text(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function submitClassification(form: FormData): Promise<void> {
  const checkpointId = text(form.get("checkpointId"));
  await controlPlane(`/internal/operator/checkpoints/${checkpointId}/classification`, {
    method: "POST",
    body: JSON.stringify({
      boundary: text(form.get("boundary")),
      planRelationship: text(form.get("planRelationship")),
      decision: text(form.get("decision")),
      affectedPolicyRules: lines(form.get("policyRules")),
      facts: lines(form.get("facts")),
      requiredDisclosureFields: lines(form.get("disclosureFields")),
      reversible: form.get("reversible") === "true",
      confidence: Number(text(form.get("confidence"))),
      rationale: text(form.get("rationale"))
    })
  });
  redirect(`/operator/checkpoints/${checkpointId}?revealed=1`);
}
