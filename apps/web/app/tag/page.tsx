"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Tagger } from "@/components/tagger";
import { useEventSlug } from "@/lib/event";

/**
 * v6 E (agent E): the participant's tagging area. `?foto=<id>` opens the panel that tags
 * someone in that photo; without it the page is the opt-in plus "the photos I am tagged in".
 */
function TagPageBody() {
  const slug = useEventSlug();
  const photoId = useSearchParams().get("foto");
  return <Tagger slug={slug} {...(photoId ? { photoId } : {})} />;
}

export default function TagPage() {
  return (
    <Suspense fallback={null}>
      <TagPageBody />
    </Suspense>
  );
}
