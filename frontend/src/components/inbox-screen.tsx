'use client';

import React, { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Mail,
  FilePlus,
  AlertTriangle,
  Paperclip,
  Search,
  RefreshCw,
  ArrowUpDown,
  Download,
  X,
  MoreHorizontal,
  FileText,
} from "lucide-react";
import { categoryLabels } from "@/data/averis-data";
import { formatSent } from "@/lib/format";
import type { EmailCategory, InboxEmail } from "@/types/averis";
import { SelectMenu, type SelectOption } from "@/components/select-menu";
import { StatCard } from "@/components/stat-card";
import { CategoryBadge } from "@/components/category-badge";
import { ConfidenceBar } from "@/components/confidence-bar";

const categoryOptions: SelectOption<"all" | EmailCategory>[] = [
  { value: "all", label: "All Categories" },
  ...(Object.keys(categoryLabels) as EmailCategory[]).map((value) => ({ value, label: categoryLabels[value] })),
];

type ConfidenceFilter = "all" | "high" | "medium" | "low" | "none";
type AttachmentFilter = "all" | "with" | "without";

const confidenceOptions: SelectOption<ConfidenceFilter>[] = [
  { value: "all", label: "Any Confidence" },
  { value: "high", label: "High (90%+)" },
  { value: "medium", label: "Medium (70-90%)" },
  { value: "low", label: "Low (below 70%)" },
  { value: "none", label: "No score" },
];

const attachmentOptions: SelectOption<AttachmentFilter>[] = [
  { value: "all", label: "Any Attachments" },
  { value: "with", label: "With attachments" },
  { value: "without", label: "No attachments" },
];

const PAGE_SIZE = 25;
// Same thresholds the confidence bar colours use (green / amber / red).
const HIGH_CONFIDENCE = 0.9;
const LOW_CONFIDENCE = 0.7; // below this the classifier was torn between categories

function confidenceBand(c: number | null): Exclude<ConfidenceFilter, "all"> {
  if (c === null) return "none"; // the ingest overrode the category, so there's no classifier score
  return c >= HIGH_CONFIDENCE ? "high" : c >= LOW_CONFIDENCE ? "medium" : "low";
}

/** "Jane Doe <jane@x.com>" -> "Jane Doe"; a bare address is returned as is. */
function senderName(from: string) {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  return m ? m[1] : from;
}

function initials(from: string) {
  const words = senderName(from).replace(/[^a-z0-9 ]/gi, " ").trim().split(/\s+/);
  const two = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return two.toUpperCase();
}

/** Page numbers to show, with "…" gaps: 1 … 4 5 6 … 21 */
function pageWindow(page: number, count: number): (number | "…")[] {
  const keep = new Set([1, count, page - 1, page, page + 1].filter((n) => n >= 1 && n <= count));
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - prev > 1) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}

const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

export function InboxScreen({ emails }: { emails: InboxEmail[] }) {
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | EmailCategory>("all");
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");
  const [attachmentFilter, setAttachmentFilter] = useState<AttachmentFilter>("all");
  const [showSpam, setShowSpam] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(1);
  const [actionMenuOpen, setActionMenuOpen] = useState<string | null>(null);

  const stats = useMemo(
    () => ({
      total: emails.length,
      comparison: emails.filter((e) => e.category === "comparison_request").length,
      newSi: emails.filter((e) => e.category === "new_si_request").length,
      // Excludes spam, which the list hides by default, so the number matches what clicking the card shows.
      lowConfidence: emails.filter((e) => e.category !== "spam" && confidenceBand(e.confidence) === "low").length,
    }),
    [emails],
  );

  const filteredRows = useMemo(() => {
    const q = query.toLowerCase();
    // Emails without a confidence always sort last.
    const conf = (e: InboxEmail) => e.confidence ?? (sortAsc ? Infinity : -Infinity);
    return emails
      .filter((row) => {
        if (!showSpam && row.category === "spam") return false;
        if (categoryFilter !== "all" && row.category !== categoryFilter) return false;
        if (confidenceFilter !== "all" && confidenceBand(row.confidence) !== confidenceFilter) return false;
        if (attachmentFilter === "with" && row.attachmentCount === 0) return false;
        if (attachmentFilter === "without" && row.attachmentCount > 0) return false;
        return `${row.from} ${row.subject} ${row.id}`.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const [x, y] = [conf(a), conf(b)];
        return x === y ? 0 : sortAsc ? x - y : y - x; // avoids Infinity - Infinity = NaN
      });
  }, [emails, showSpam, categoryFilter, confidenceFilter, attachmentFilter, query, sortAsc]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const firstIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filteredRows.slice(firstIndex, firstIndex + PAGE_SIZE);
  const activeFilters =
    (query ? 1 : 0) +
    (categoryFilter !== "all" ? 1 : 0) +
    (confidenceFilter !== "all" ? 1 : 0) +
    (attachmentFilter !== "all" ? 1 : 0) +
    (showSpam ? 1 : 0);

  // Re-reads the emails collection: refreshes the Server Component in place.
  const handleRefresh = () => startRefresh(() => router.refresh());

  const handleExport = () => {
    const csv = [
      ["Email ID", "Category", "Confidence", "From", "Subject"].map(csvCell).join(","),
      ...filteredRows.map((r) =>
        [r.id, r.category, r.confidence === null ? "" : `${(r.confidence * 100).toFixed(1)}%`, r.from, r.subject]
          .map(csvCell)
          .join(","),
      ),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "averis_inbox_report.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Inbox</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage incoming shipping documents and verify them against digital instructions.
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Received" value={stats.total.toLocaleString()} icon={Mail} tone="info" />
        <StatCard label="Comparison Requests" value={stats.comparison.toLocaleString()} icon={Paperclip} tone="success" />
        <StatCard label="New SI Requests" value={stats.newSi.toLocaleString()} icon={FilePlus} tone="info" />
        <StatCard
          label="Low Confidence"
          value={stats.lowConfidence.toLocaleString()}
          icon={AlertTriangle}
          tone="warning"
          note={`Below ${LOW_CONFIDENCE * 100}%`}
          active={confidenceFilter === "low"}
          onClick={() => {
            setConfidenceFilter(confidenceFilter === "low" ? "all" : "low");
            setPage(1);
          }}
        />
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <div className="relative min-w-[280px] flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search by sender, subject, or SI ref"
            className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50/50 pl-9 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:bg-white focus:outline-none"
          />
        </div>

        {/* Only shown while something is filtered; the search box, category
            dropdown and spam toggle are the filters themselves. */}
        {activeFilters > 0 && (
          <button
            type="button"
            onClick={() => {
              setCategoryFilter("all");
              setConfidenceFilter("all");
              setAttachmentFilter("all");
              setQuery("");
              setShowSpam(false);
              setPage(1);
            }}
            className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 active:scale-[0.98]"
          >
            <X className="h-4 w-4 text-slate-500" />
            Clear filters
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-50 text-xs font-bold text-red-500">
              {activeFilters}
            </span>
          </button>
        )}

        <SelectMenu
          ariaLabel="Filter emails by category"
          value={categoryFilter}
          onChange={(value) => {
            setCategoryFilter(value);
            setPage(1);
          }}
          options={categoryOptions}
        />

        <SelectMenu
          ariaLabel="Filter emails by confidence"
          value={confidenceFilter}
          onChange={(value) => {
            setConfidenceFilter(value);
            setPage(1);
          }}
          options={confidenceOptions}
        />

        <SelectMenu
          ariaLabel="Filter emails by attachments"
          value={attachmentFilter}
          onChange={(value) => {
            setAttachmentFilter(value);
            setPage(1);
          }}
          options={attachmentOptions}
        />

        {/* Show Spam Toggle */}
        <label className="flex cursor-pointer items-center gap-2.5 pl-2 text-sm font-semibold text-slate-700 select-none">
          <input
            type="checkbox"
            checked={showSpam}
            onChange={(e) => {
              setShowSpam(e.target.checked);
              setPage(1);
            }}
            className="peer sr-only"
          />
          <span className="relative h-6 w-11 rounded-full bg-slate-200 transition-colors peer-checked:bg-red-500 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5" />
          Show Spam
        </label>

        <div className="flex items-center gap-1.5 border-l border-slate-200 pl-3">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            aria-label="Refresh data"
            className={`flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 ${
              isRefreshing ? "animate-spin" : ""
            }`}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setSortAsc(!sortAsc);
              setPage(1);
            }}
            aria-label="Sort by confidence score"
            title="Sort by confidence"
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            <ArrowUpDown className="h-4 w-4" />
          </button>
        </div>

        <button
          type="button"
          onClick={handleExport}
          className="flex h-10 items-center gap-2 rounded-lg bg-red-500 px-4 text-sm font-semibold text-white shadow-sm hover:bg-red-600 active:scale-[0.98]"
        >
          <Download className="h-4 w-4" />
          Export Report
        </button>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-6 py-4">Sender</th>
                <th className="px-6 py-4">Subject</th>
                <th className="px-6 py-4">Category</th>
                <th className="px-6 py-4">Confidence</th>
                <th className="px-6 py-4">Sent</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-sm text-slate-500">
                    {emails.length === 0
                      ? "No emails yet. Load them with `npm run ingest` in frontend/."
                      : "No emails match your filters."}
                  </td>
                </tr>
              )}
              {pageRows.map((row) => {
                const isComparison = row.category === "comparison_request";

                return (
                  <tr
                    key={row.docId}
                    onClick={() => router.push(`/emails/${row.docId}`)}
                    className="cursor-pointer transition-colors hover:bg-slate-50/80"
                  >
                    <td className="px-6 py-4 font-semibold text-slate-900">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-700">
                          {initials(row.from)}
                        </div>
                        <span className="truncate max-w-[200px]" title={row.from}>
                          {senderName(row.from)}
                        </span>
                      </div>
                    </td>

                    <td className="px-6 py-4">
                      <div className="max-w-md truncate font-semibold text-slate-900" title={row.subject}>
                        <Link
                          href={`/emails/${row.docId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:underline"
                        >
                          {row.subject || "(no subject)"}
                        </Link>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                        <FileText className="h-3.5 w-3.5 text-slate-400" />
                        <span>
                          {row.attachmentCount > 0
                            ? `${row.attachmentCount} attachment${row.attachmentCount > 1 ? "s" : ""}`
                            : "No attachments"}
                        </span>
                      </div>
                    </td>

                    <td className="px-6 py-4">
                      <CategoryBadge category={row.category} />
                    </td>

                    <td className="px-6 py-4">
                      {row.confidence === null ? (
                        <span className="text-xs text-slate-400" title="Category set at ingest, no classifier score">
                          —
                        </span>
                      ) : (
                        <ConfidenceBar value={row.confidence} />
                      )}
                    </td>

                    <td className="px-6 py-4 text-xs font-medium whitespace-nowrap text-slate-600">
                      {formatSent(row.sentAt) ?? "—"}
                    </td>

                    <td className="px-6 py-4 text-right">
                      <div className="relative inline-block">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setActionMenuOpen(actionMenuOpen === row.docId ? null : row.docId);
                          }}
                          aria-label={`Actions for ${row.id}`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                        {actionMenuOpen === row.docId && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="absolute right-0 top-9 z-20 w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
                          >
                            <button
                              type="button"
                              onClick={() => router.push(`/emails/${row.docId}`)}
                              className="w-full px-4 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              View Details
                            </button>
                            {isComparison && (
                              <button
                                type="button"
                                onClick={() => router.push(`/comparison/${row.id}`)}
                                className="w-full px-4 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                View Comparison
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                alert(`Flagged ${row.id} for review.`);
                                setActionMenuOpen(null);
                              }}
                              className="w-full px-4 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              Flag for Review
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-slate-200 px-6 py-4 text-xs font-medium text-slate-500">
          <span>
            Showing{" "}
            <strong className="font-semibold text-slate-900">
              {filteredRows.length === 0 ? 0 : firstIndex + 1}
            </strong>{" "}
            to <strong className="font-semibold text-slate-900">{firstIndex + pageRows.length}</strong> of{" "}
            <strong className="font-semibold text-slate-900">{filteredRows.length}</strong> emails
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 1}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Previous
            </button>
            {pageWindow(currentPage, pageCount).map((n, i) =>
              n === "…" ? (
                <span key={`gap-${i}`} className="px-1 text-slate-400">
                  …
                </span>
              ) : (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPage(n)}
                  aria-current={n === currentPage ? "page" : undefined}
                  className={
                    n === currentPage
                      ? "flex h-7 w-7 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white shadow-sm"
                      : "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  }
                >
                  {n}
                </button>
              ),
            )}
            <button
              type="button"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage === pageCount}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
