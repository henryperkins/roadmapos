import Link from "next/link";

export default function HomePage() {
  return (
    <section>
      <h1>RoadmapOS pilot portal</h1>
      <p><Link href="/operator/checkpoints">Operator checkpoints</Link></p>
    </section>
  );
}
