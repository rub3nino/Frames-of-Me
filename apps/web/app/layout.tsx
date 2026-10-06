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
  title: "RePhoto",
  description: "Trova le foto dell'evento in cui compari.",
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
