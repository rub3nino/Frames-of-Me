"use client";

import { Gallery } from "@/components/gallery";
import { useEventSlug } from "@/lib/event";

export default function GalleryPage() {
  const slug = useEventSlug();
  return <Gallery slug={slug} />;
}
