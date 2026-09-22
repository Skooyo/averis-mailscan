'use client';

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Search,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  FileText,
  Activity,
} from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { SelectMenu, type SelectOption } from "@/components/select-menu";
import { StatCard } from "@/components/stat-card";
import { compareEmailId } from "@/lib/sort";
import type { ReviewItem } from "@/types/averis";

type TabFilter = "all" | "match" | "mismatch" | "error";
type SortMode = "processed" | "emailId";

const sortOptions: SelectOption<SortMode>[] = [
  { value: "processed", label: "Most recently processed" },
  { value: "emailId", label: "Email ID" },
];

const STATUS_LABELS: Record<ReviewItem["status"], string> = {
  match: "Match",
  mismatch: "Mismatch",
  error: "Processing Error",
  skipped: "Not Applicable",
  unclassified: "Unclassified",
};

const STATUS_ICON: Record<"match" | "mismatch" | "error", typeof CheckCircle2> = {
  match: CheckCircle2,
  mismatch: AlertTriangle,
  error: AlertCircle,
};

const STATUS_STYLES: Record<"match" | "mismatch" | "error", string> = {
  match: "border-emerald-200 bg-emerald-50 text-emerald-600",
  mismatch: "border-amber-200 bg-amber-50 text-amber-600",
  error: "border-red-200 bg-red-50 text-red-500",
};

const STATUS_BADGE: Record<"match" | "mismatch" | "error", string> = {
  match: "bg-emerald-100 text-emerald-700",
  mismatch: "bg-amber-100 text-amber-700",
  error: "bg-red-100 text-red-600",
};

interface ReviewScreenProps {
  items: ReviewItem[];
}

export function ReviewScreen({ items }: ReviewScreenProps) {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  // "Most recently processed" is the order the server already sent (Result.processed_at desc);
  // "Email ID" re-sorts client-side -- most of the dataset is the sample set's "email_NNN" ids,
  // which people naturally want to browse in that order.
  const [sortMode, setSortMode] = useState<SortMode>("processed");
  // Only for the (optional) escalation-reasons detail -- separate from opening the comparison,
  // which every row does directly on click. Nothing needed to open a comparison is hidden here.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const matchCount = items.filter((i) => i.status === "match").length;
  const mismatchCount = items.filter((i) => i.status === "mismatch").length;
  const errorCount = items.filter((i) => i.status === "error").length;

  const filteredQueue = useMemo(() => {
    const filtered = items.filter((item) => {
      if (activeTab !== "all" && item.status !== activeTab) return false;
      const text = `${item.emailId} ${item.subject ?? ""} ${item.from ?? ""} ${item.message} ${item.reasons
        .map((r) => `${r.code} ${r.detail}`)
        .join(" ")}`.toLowerCase();
      return text.includes(searchQuery.toLowerCase());
    });
    if (sortMode === "emailId") return [...filtered].sort((a, b) => compareEmailId(a.emailId, b.emailId, true));
    return filtered;
  }, [items, activeTab, searchQuery, sortMode]);

  const openComparison = (emailId: string) => router.push(`/comparison/${encodeURIComponent(emailId)}`);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Review</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every shipping-document comparison the pipeline has run, correct or not. Click a row to
            open its full comparison.
          </p>
        </div>

        <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {(
            [
              ["all", `All (${items.length})`],
              ["match", `Matches (${matchCount})`],
              ["mismatch", `Mismatches (${mismatchCount})`],
              ["error", `Errors (${errorCount})`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setActiveTab(value)}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors ${
                activeTab === value ? "bg-red-500 text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Reviewed" value={String(items.length)} icon={ShieldAlert} tone="warning" />
        <StatCard label="Matches" value={String(matchCount)} icon={CheckCircle2} tone="success" />
        <StatCard label="Mismatches" value={String(mismatchCount)} icon={AlertTriangle} tone="warning" />
        <StatCard label="Errors" value={String(errorCount)} icon={AlertCircle} tone="info" />
      </div>

      <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by email id, subject, sender, or reason..."
            className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50/50 pl-9 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:bg-white focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-500">Sort:</span>
          <SelectMenu ariaLabel="Sort comparisons" value={sortMode} onChange={setSortMode} options={sortOptions} />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-sm">
          <FileText className="mx-auto h-10 w-10 text-slate-300" />
          <h3 className="mt-3 text-sm font-bold text-slate-800">No comparisons yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
            No comparison_request email has been through the pipeline yet in this environment. Run{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5">python -m backend.pipeline --write-db</code>, or check
            back once one has synced.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredQueue.map((item) => {
            const isExpanded = expandedId === item.emailId;
            const Icon = STATUS_ICON[item.status as "match" | "mismatch" | "error"];

            return (
              <div
                key={item.emailId}
                onClick={() => openComparison(item.emailId)}
                className="cursor-pointer overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all hover:border-slate-300 hover:shadow-md"
              >
                <div className="flex w-full items-center justify-between gap-4 p-4 text-left">
                  <div className="flex items-center gap-4">
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${STATUS_STYLES[item.status as "match" | "mismatch" | "error"]}`}
                    >
                      <Icon className="h-5 w-5" />
                    </div>

                    <div>
                      <span className="font-bold text-slate-900">{item.emailId}</span>
                      <span
                        className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${STATUS_BADGE[item.status as "match" | "mismatch" | "error"]}`}
                      >
                        {STATUS_LABELS[item.status]}
                      </span>
                      {item.required && (
                        <span
                          className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                            item.resolved ? "bg-slate-100 text-slate-500" : "bg-red-100 text-red-600"
                          }`}
                        >
                          {item.resolved ? "Resolved" : "Needs Review"}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-1 items-center gap-8 overflow-hidden text-xs">
                    <div className="min-w-0 flex-1">
                      <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">Subject</span>
                      <span className="block truncate font-semibold text-slate-900">
                        {item.subject || "(subject not stored)"}
                      </span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">Result</span>
                      <span className="block truncate font-semibold text-slate-700">{item.message}</span>
                    </div>

                    <div className="w-40 shrink-0 text-right">
                      <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">Processed</span>
                      <span className="font-semibold text-slate-700">
                        <RelativeTime iso={item.processedAt} />
                      </span>
                    </div>

                    {item.reasons.length > 0 ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation(); // shows reasons in place, without opening the comparison
                          setExpandedId(isExpanded ? null : item.emailId);
                        }}
                        aria-label={isExpanded ? "Hide escalation reasons" : "Show escalation reasons"}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      >
                        {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                    ) : (
                      <ChevronRight className="h-4 w-4 text-slate-300" aria-hidden="true" />
                    )}
                  </div>
                </div>

                {isExpanded && item.reasons.length > 0 && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="border-t border-slate-100 bg-slate-50/70 p-5"
                  >
                    <h4 className="text-xs font-bold tracking-wider text-slate-500 uppercase">Escalation Reasons</h4>
                    <ul className="mt-2 space-y-1.5">
                      {item.reasons.map((r, i) => (
                        <li key={i} className="text-sm text-slate-800">
                          <span className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-slate-600">
                            {r.code}
                          </span>{" "}
                          {r.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}

          {filteredQueue.length === 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
              <FileText className="mx-auto mb-2 h-6 w-6 text-slate-300" />
              No emails match this filter.
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-slate-200 pt-4 text-xs font-medium text-slate-500">
        <span>
          Displaying <strong className="font-semibold text-slate-900">{filteredQueue.length}</strong> of{" "}
          <strong className="font-semibold text-slate-900">{items.length}</strong> comparisons
        </span>
        <span className="flex items-center gap-1.5 font-bold tracking-wider text-slate-400 uppercase">
          <Activity className="h-3 w-3" />
          End of Queue
        </span>
      </div>
    </div>
  );
}
