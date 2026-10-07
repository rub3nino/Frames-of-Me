import type { MetadataRoute } from "next";

/** Installable "Frames of Me Upload" app: opens straight on the uploader. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Frames of Me Upload",
    short_name: "Frames of Me",
    description: "Carica le foto dell'evento in automatico da una cartella.",
    start_url: "/upload",
    scope: "/",
    display: "standalone",
    background_color: "#f3eee6",
    theme_color: "#f3eee6",
    lang: "it",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
