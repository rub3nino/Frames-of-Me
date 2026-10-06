"use client";

import { useParams } from "next/navigation";
import { Gallery } from "@/components/gallery";

export default function EventGalleryPage() {
  const params = useParams<{ slug: string }>();
  const slug = typeof params.slug === "string" ? params.slug : "";
  if (!slug) return null;
  return <Gallery slug={slug} />;
}
