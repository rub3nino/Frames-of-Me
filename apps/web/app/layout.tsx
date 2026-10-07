import type { Metadata, Viewport } from "next";
import { Source_Sans_3 } from "next/font/google";
import { ToastProvider } from "@/components/toast";
import "./globals.css";

const sourceSans = Source_Sans_3({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Frames of Me",
  description: "Trova le foto dell'evento in cui compari.",
  // app/manifest.ts is linked automatically; these make the installed uploader look native.
  applicationName: "Frames of Me",
  appleWebApp: { capable: true, title: "Frames of Me Upload", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#f3eee6",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body className={sourceSans.className}>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
