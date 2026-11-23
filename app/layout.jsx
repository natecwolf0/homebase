export const metadata = {
  title: "HOMEBASE",
  description: "A comp-driven home valuation workbench. The list price is an opinion. Closed comps are the fact.",
  manifest: "/manifest.webmanifest",
  robots: { index: false, follow: false },
  icons: { icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }, { url: "/icon-512.png", sizes: "512x512", type: "image/png" }], apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "HOMEBASE", statusBarStyle: "default" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#faf8f3",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#faf8f3" }}>{children}</body>
    </html>
  );
}
