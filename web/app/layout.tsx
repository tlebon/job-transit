import type { Metadata } from "next";
import "@fontsource/overpass/400.css";
import "@fontsource/overpass/600.css";
import "@fontsource/overpass/700.css";
import "@fontsource/overpass/800.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Transit",
  description: "Plan a realistic next job from your skills, interests and where people actually move.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
