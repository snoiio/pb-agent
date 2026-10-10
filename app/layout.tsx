import type { Viewport } from "next";

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#1a1a2e", color: "#eee", fontFamily: "system-ui" }}>
        {children}
      </body>
    </html>
  );
}
