"use client";

import { Gallery } from "@/components/gallery";
import { eventSlug } from "@/lib/event";

export default function GalleryPage() {
  return <Gallery slug={eventSlug} />;
}
