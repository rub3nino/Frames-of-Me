import { redirect } from "next/navigation";

export default async function LegacyGallery({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/e/${slug}`);
}
