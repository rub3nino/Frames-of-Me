"use client";

import Link from "next/link";
import { SignOut } from "@/components/sign-out";

export function Shell({
  children,
  wide = false,
  signOut = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
  signOut?: boolean;
}) {
  return (
    <div className={wide ? "shell shell-wide" : "shell"}>
      <header className="top">
        <Link className="mark" href="/">
          Frames of Me
        </Link>
        {signOut ? <SignOut /> : null}
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
