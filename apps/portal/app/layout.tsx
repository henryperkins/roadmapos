import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "RoadmapOS Pilot" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en"><body><header><strong>RoadmapOS Pilot</strong></header><main>{children}</main></body></html>;
}
