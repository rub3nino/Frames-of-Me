const raw = process.env.NEXT_PUBLIC_EVENT_SLUG || "demo";

export const eventSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) ? raw : "demo";
