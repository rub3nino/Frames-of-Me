"use client";

import { PublicGallery } from "@/components/public-gallery";
import { useEventSlug } from "@/lib/event";

export default function PublicGalleryPage() {
  return <PublicGallery slug={useEventSlug()} />;
}
