'use client';

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Mail,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Search,
  Filter,
  RefreshCw,
  ArrowUpDown,
  Download,
  MoreHorizontal,
  FileText,
} from "lucide-react";
import {
  classificationData,
  emailPresentation,
  supplementalEmails,
  categoryLabels,
} from "@/data/averis-data";
import type { ClassifiedEmail, EmailCategory } from "@/types/averis";
import { StatCard } from "@/components/stat-card";
import { CategoryBadge } from "@/components/category-badge";
import { ConfidenceBar } from "@/components/confidence-bar";

export function InboxScreen() {
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | EmailCategory>("all");
  const [showSpam, setShowSpam] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sortAsc, setSortAsc] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState<string | null>(null);

  const initialRows: ClassifiedEmail[] = useMemo(() => {
    return [...Object.values(classificationData), ...supplementalEmails];
  }, []);

  const filteredRows = useMemo(() => {
    return initialRows
      .filter((row) => {
        if (!showSpam && row.category === "spam") return false;
        if (categoryFilter !== "all" && row.category !== categoryFilter) return false;
        const details = emailPresentation[row.email_id];
        const searchText = `${details?.sender ?? ""} ${details?.subject ?? ""} ${
          details?.reference ?? ""
        }`.toLowerCase();
        return searchText.includes(query.toLowerCase());
      })
      .sort((a, b) => (sortAsc ? a.confidence - b.confidence : b.confidence - a.confidence));
  }, [initialRows, showSpam, categoryFilter, query, sortAsc]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => setIsRefreshing(false), 500);
  };

  const handleExport = () => {
    const csvContent =
      "data:text/csv;charset=utf-8," +
      ["Email ID,Category,Confidence,Status,Needs Review"]
        .concat(
          filteredRows.map(
            (r) =>
              `${r.email_id},${r.category},${(r.confidence * 100).toFixed(1)}%,${r.status},${
                r.needs_review
              }`
          )
        )
        .join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "averis_inbox_report.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
        <StatCard label="Total Received" value="1,284" icon={Mail} tone="danger" />
        <StatCard label="Verified Auto" value="842" icon={CheckCircle2} tone="success" />
        <StatCard label="Mismatches" value="12" icon={AlertTriangle} tone="warning" />
        <StatCard label="Avg. Turnaround" value="14m" icon={Clock} tone="info" />
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <div className="relative min-w-[280px] flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by sender, subject, or SI ref"
            className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50/50 pl-9 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:bg-white focus:outline-none"
          />
        </div>

        <button
          type="button"
          onClick={() => {
            setCategoryFilter("all");
            setQuery("");
          }}
          className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 active:scale-[0.98]"
        >
          <Filter className="h-4 w-4 text-slate-500" />
          Filters
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-50 text-xs font-bold text-red-500">
            3
          </span>
        </button>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as "all" | EmailCategory)}
          aria-label="Filter emails by category"
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 focus:border-red-500 focus:outline-none"
        >
          <option value="all">All Categories</option>
          {Object.entries(categoryLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        {/* Show Spam Toggle */}
        <label className="flex cursor-pointer items-center gap-2.5 pl-2 text-sm font-semibold text-slate-700 select-none">
          <input
            type="checkbox"
            checked={showSpam}
            onChange={(e) => setShowSpam(e.target.checked)}
            className="peer sr-only"
          />
          <span className="relative h-6 w-11 rounded-full bg-slate-200 transition-colors peer-checked:bg-red-500 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5" />
          Show Spam
        </label>

        <div className="flex items-center gap-1.5 border-l border-slate-200 pl-3">
          <button
            type="button"
            onClick={handleRefresh}
            aria-label="Refresh data"
            className={`flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 ${
              isRefreshing ? "animate-spin" : ""
            }`}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setSortAsc(!sortAsc)}
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
                <th className="px-6 py-4">Received</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredRows.map((row) => {
                const details = emailPresentation[row.email_id] || {
                  sender: "Unknown Carrier",
                  initials: "UC",
                  subject: row.email_id,
                  reference: "N/A",
                  received: "Today",
                };
                const isComparison = row.category === "comparison_request";

                return (
                  <tr
                    key={row.email_id}
                    onClick={() => {
                      if (isComparison) router.push(`/comparison/${row.email_id}`);
                    }}
                    className={`transition-colors ${
                      isComparison ? "cursor-pointer hover:bg-slate-50/80" : "cursor-default opacity-85"
                    }`}
                  >
                    <td className="px-6 py-4 font-semibold text-slate-900">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-700">
                          {details.initials}
                        </div>
                        <span className="truncate max-w-[200px]">{details.sender}</span>
                      </div>
                    </td>

                    <td className="px-6 py-4">
                      <div className="font-semibold text-slate-900">{details.subject}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                        <FileText className="h-3.5 w-3.5 text-slate-400" />
                        <span>{details.reference}</span>
                      </div>
                    </td>

                    <td className="px-6 py-4">
                      <CategoryBadge category={row.category} />
                    </td>

                    <td className="px-6 py-4">
                      <ConfidenceBar value={row.confidence} />
                    </td>

                    <td className="px-6 py-4 whitespace-nowrap text-xs font-medium text-slate-600">
                      {details.received}
                    </td>

                    <td className="px-6 py-4 text-right">
                      <div className="relative inline-block">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setActionMenuOpen(actionMenuOpen === row.email_id ? null : row.email_id);
                          }}
                          aria-label={`Actions for ${row.email_id}`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                        {actionMenuOpen === row.email_id && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="absolute right-0 top-9 z-20 w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
                          >
                            {isComparison && (
                              <button
                                type="button"
                                onClick={() => router.push(`/comparison/${row.email_id}`)}
                                className="w-full px-4 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                View Comparison
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                alert(`Flagged ${row.email_id} for review.`);
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
            Showing <strong className="font-semibold text-slate-900">1</strong> to{" "}
            <strong className="font-semibold text-slate-900">{filteredRows.length}</strong> of{" "}
            <strong className="font-semibold text-slate-900">142</strong> documents
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              disabled
            >
              Previous
            </button>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white shadow-sm"
            >
              1
            </button>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              2
            </button>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              3
            </button>
            <span className="px-1 text-slate-400">...</span>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              29
            </button>
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
