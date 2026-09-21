'use client';

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileSpreadsheet, Inbox, ShieldCheck, Search, Bell, ChevronDown } from "lucide-react";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isInboxActive = pathname === "/" || pathname.startsWith("/comparison");
  const isReviewActive = pathname.startsWith("/review");

  return (
    <div className="flex min-h-screen bg-[#F8FAFC] text-slate-900">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-slate-200 bg-white">
        <div className="flex h-16 items-center gap-2.5 px-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500 text-white shadow-sm">
            <FileSpreadsheet className="h-4 w-4" />
          </div>
          <span className="text-lg font-bold tracking-tight text-slate-900">Averis</span>
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
            <Link href="/" className="hover:text-slate-900">Inbox</Link>
            <span>&gt;</span>
            <span className="font-semibold text-slate-900">Verify Documents</span>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search documents..."
                className="h-9 w-64 rounded-lg border border-slate-200 bg-slate-50/50 pl-9 pr-4 text-xs text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:bg-white focus:outline-none"
              />
            </div>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
              aria-label="Notifications"
            >
              <Bell className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2 border-l border-slate-200 pl-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">
                DR
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </div>
          </div>
        </header>

        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
 