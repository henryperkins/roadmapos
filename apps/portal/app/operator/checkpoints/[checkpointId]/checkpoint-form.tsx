const PLAN_RELATIONSHIPS = [
  "within_plan",
  "editorial_only",
  "materially_equivalent_variation",
  "material_scope_expansion",
  "plan_invalidating_change",
  "requirement_conflict",
  "verification_blocked"
] as const;

export interface CheckpointFormProps {
  checkpointId: string;
  packageHash: string;
  frozenPackage: unknown;
  action: (form: FormData) => void | Promise<void>;
}

/**
 * The operator's independent classification form. It is deliberately built only from the frozen
 * checkpoint package: nothing rendered here derives from the agent's committed label, so an
 * operator cannot read the agent's view before submitting their own.
 */
export function CheckpointForm({ checkpointId, packageHash, frozenPackage, action }: CheckpointFormProps) {
  return (
    <section>
      <h1>Independent checkpoint classification</h1>
      <p>Package hash: <code>{packageHash}</code></p>
      <pre>{JSON.stringify(frozenPackage, null, 2)}</pre>
      <form action={action}>
        <input type="hidden" name="checkpointId" value={checkpointId} />
        <label>Boundary<select name="boundary" required defaultValue="none"><option value="none">None</option><option value="repository_protected">Repository protected</option><option value="platform_hard_stop">Platform hard stop</option></select></label>
        <label>Plan relationship<select name="planRelationship" required defaultValue="within_plan">{PLAN_RELATIONSHIPS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Decision<select name="decision" required defaultValue="continue"><option value="continue">Continue</option><option value="pause_and_escalate">Pause and escalate</option><option value="stop">Stop</option></select></label>
        <label>Facts<textarea name="facts" required /></label>
        <label>Policy rules<textarea name="policyRules" /></label>
        <label>Required disclosure fields<textarea name="disclosureFields" /></label>
        <label>Reversible<input name="reversible" type="checkbox" value="true" /></label>
        <label>Confidence<input name="confidence" type="number" min="0" max="100" required /></label>
        <label>Operator rationale<textarea name="rationale" required /></label>
        <button type="submit">Commit independent classification</button>
      </form>
    </section>
  );
}
