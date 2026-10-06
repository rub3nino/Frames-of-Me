import type { Role } from "@/lib/types";

export function pathForRole(role: Role): string {
  if (role === "photographer") return "/upload";
  if (role === "admin") return "/admin";
  return "/selfie";
}
