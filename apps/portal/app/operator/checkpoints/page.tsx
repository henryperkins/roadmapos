import Link from "next/link";

/**
 * Milestone 2 exposes one checkpoint at a time, reached from the GitHub check's details URL.
 * The queue view arrives with the auditor dashboards in Milestone 3.
 */
export default function CheckpointIndexPage() {
  return (
    <section>
      <h1>Operator checkpoints</h1>
      <p>
        A frozen governance checkpoint is reached from the &ldquo;RoadmapOS governance gate&rdquo; check on the
        pull request or issue. Open the check&rsquo;s details link, or navigate directly to
        <code> /operator/checkpoints/&lt;checkpointId&gt;</code>.
      </p>
      <form action="/operator/checkpoints" method="get">
        <label>Checkpoint ID<input name="checkpointId" required placeholder="00000000-0000-4000-8000-000000000000" /></label>
        <button type="submit">Open checkpoint</button>
      </form>
      <p><Link href="/">Back</Link></p>
    </section>
  );
}
