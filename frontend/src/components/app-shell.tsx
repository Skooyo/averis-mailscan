'use client';

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileSpreadsheet, Inbox, ShieldCheck } from "lucide-react";
import type { CurrentUser } from "@/lib/session";

function initialsOf(user: CurrentUser) {
  const words = (user.name || user.email.split("@")[0]).split(/[\s._-]+/).filter(Boolean);
  const two = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return two.toUpperCase();
}

export function AppShell({ user, children }: { user: CurrentUser | null; children: React.ReactNode }) {
  const pathname = usePathname();
  const isInboxActive = pathname === "/" || pathname.startsWith("/comparison");
  const isReviewActive = pathname.startsWith("/review");

  // The login page is full-screen, without the sidebar and header.
  if (pathname === "/login") return <>{children}</>;

  return (
    <div className="flex min-h-screen bg-[#F8FAFC] text-slate-900">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-slate-200 bg-white">
        <div className="flex h-16 items-center gap-2.5 px-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500 text-white shadow-sm">
            <FileSpreadsheet className="h-4 w-4" />
          </div>
          <span className="text-lg font-bold tracking-tight text-slate-900">MailScan</span>
        </div>

        <nav className="mt-4 flex-1 space-y-1 px-3">
          <Link
            href="/"
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
              isInboxActive
                ? "bg-slate-100 text-slate-900"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            <Inbox className="h-4 w-4" />
            Inbox
          </Link>

          <Link
            href="/review"
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
              isReviewActive
                ? "bg-slate-100 text-slate-900"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            <ShieldCheck className="h-4 w-4" />
            Review
          </Link>
        </nav>

        <div className="p-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
            <span className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
              System Status
            </span>
            <div className="mt-1 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Operational
            </div>
          </div>
        </div>
      </aside>

      {/* Main Container */}
      <div className="flex min-w-0 flex-1 flex-col pl-60">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-8 backdrop-blur">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <span>Dashboard</span>
            <span>&gt;</span>
            <Link href="/" className="font-semibold text-slate-900">Inbox</Link>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              {user ? (
                <>
                  <div
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700"
                    title={user.email}
                  >
                    {initialsOf(user)}
                  </div>
                  <span className="hidden max-w-44 truncate text-xs font-semibold text-slate-700 lg:block">
                    {user.name || user.email}
                  </span>
                  <form action="/api/auth/logout" method="post">
                    <button
                      type="submit"
                      className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      Sign out
                    </button>
                  </form>
                </>
              ) : (
                <Link
                  href="/login"
                  className="flex h-8 items-center rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Sign in
                </Link>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
 