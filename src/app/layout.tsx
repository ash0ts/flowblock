import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowBlock | Make the move",
  description:
    "Plan a product shot in your space, rehearse the camera move, and review your take.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "FlowBlock", statusBarStyle: "default" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f4ed",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
