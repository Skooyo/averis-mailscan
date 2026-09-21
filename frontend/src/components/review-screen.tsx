'use client';

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Search,
  ChevronDown,
  ChevronUp,
  FileText,
  Check,
  Activity,
} from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { StatCard } from "@/components/stat-card";
import type { EscalationQueueItem } from "@/types/averis";

type TabFilter = "all" | "unresolved" | "mismatch";

const STATUS_LABELS: Record<EscalationQueueItem["status"], string> = {
  match: "Match",
  mismatch: "Mismatch",
  error: "Processing Error",
  skipped: "Not Applicable",
  unclassified: "Unclassified",
};

/** No assignment/priority concept exists on the backend (backend/escalate.py's EscalationReport
 * has no such field) -- this derives a simple, honest "how urgent" signal from what IS real:
 * an unresolved processing error or mismatch outranks an unresolved missing-field/low-confidence
 * flag, and anything already resolved sinks to the bottom regardless of its original reasons. */
function urgencyOf(item: EscalationQueueItem): "high" | "medium" | "low" {
  if (item.resolved) return "low";
  if (item.status === "error" || item.status === "mismatch") return "high";
  return "medium";
}

const URGENCY_STYLES: Record<"high" | "medium" | "low", string> = {
  high: "bg-red-100 text-red-600",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-slate-100 text-slate-600",
};

interface ReviewScreenProps {
  items: EscalationQueueItem[];
}

export function ReviewScreen({ items }: ReviewScreenProps) {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(items[0]?.emailId ?? null);

  const unresolvedCount = items.filter((i) => !i.resolved).length;
  const mismatchCount = items.filter((i) => i.status === "mismatch").length;
  const errorCount = items.filter((i) => i.status === "error").length;

  const filteredQueue = useMemo(() => {
    return items.filter((item) => {
      if (activeTab === "unresolved" && item.resolved) return false;
      if (activeTab === "mismatch" && item.status !== "mismatch") return false;
      const text = `${item.emailId} ${item.subject ?? ""} ${item.from ?? ""} ${item.reasons
        .map((r) => `${r.code} ${r.detail}`)
        .join(" ")}`.toLowerCase();
      return text.includes(searchQuery.toLowerCase());
    });
  }, [items, activeTab, searchQuery]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Review</h1>
          <p className="mt-1 text-sm text-slate-500">
            Emails the pipeline flagged for human review (backend/escalate.py), across every
            comparison, extraction, and classification stage.
          </p>
        </div>

        <div className="flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {(
            [
              ["all", `All (${items.length})`],
              ["unresolved", `Unresolved (${unresolvedCount})`],
              ["mismatch", `Mismatches (${mismatchCount})`],
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
        <StatCard label="Escalated" value={String(items.length)} icon={ShieldAlert} tone="warning" />
        <StatCard label="Unresolved" value={String(unresolvedCount)} icon={AlertTriangle} tone="warning" />
        <StatCard label="Mismatches" value={String(mismatchCount)} icon={ShieldAlert} tone="info" />
        <StatCard label="Processing Errors" value={String(errorCount)} icon={AlertTriangle} tone="info" />
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
        <div className="text-xs font-medium text-slate-500">
          Sort: <span className="font-bold text-slate-900">Most recently processed</span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-sm">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-300" />
          <h3 className="mt-3 text-sm font-bold text-slate-800">Nothing needs review</h3>
          <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
            No processed email currently has escalation.required set. Either everything is clean, or
            the pipeline hasn&apos;t been run against MongoDB yet (see HANDOVER.md).
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredQueue.map((item) => {
            const isExpanded = expandedId === item.emailId;
            const urgency = urgencyOf(item);

            return (
              <div
                key={item.emailId}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all"
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : item.emailId)}
                  className="flex w-full items-center justify-between gap-4 p-4 text-left transition-colors hover:bg-slate-50/60"
                >
                  <div className="flex items-center gap-4">
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                        urgency === "high"
                          ? "border border-red-200 bg-red-50 text-red-500"
                          : "border border-slate-200 bg-slate-100 text-slate-600"
                      }`}
                    >
                      {item.resolved ? <CheckCircle2 className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}
                    </div>

                    <div>
                      <span className="font-bold text-slate-900">{item.emailId}</span>
                      <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${URGENCY_STYLES[urgency]}`}>
                        {item.resolved ? "resolved" : urgency}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-1 items-center gap-8 overflow-hidden text-xs">
                    <div className="min-w-0 flex-1">
                      <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">Subject</span>
                      <span className="block truncate font-semibold text-slate-900">
                        {item.subject || "(subject not stored)"}
                      </span>
                    </div>

                    <div className="w-32 shrink-0">
                      <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">Status</span>
                      <span className="font-semibold text-slate-900">{STATUS_LABELS[item.status]}</span>
                    </div>

                    <div className="w-40 shrink-0 text-right">
                      <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">Processed</span>
                      <span className="font-semibold text-slate-700">
                        <RelativeTime iso={item.processedAt} />
                      </span>
                    </div>

                    <div className="text-slate-400">
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-slate-100 bg-slate-50/70 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="max-w-2xl">
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

                      <button
                        type="button"
                        onClick={() => router.push(`/comparison/${encodeURIComponent(item.emailId)}`)}
                        className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-red-500 px-4 text-xs font-bold text-white shadow-sm hover:bg-red-600 active:scale-[0.98]"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Open Comparison
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {filteredQueue.length === 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
              <FileText className="mx-auto mb-2 h-6 w-6 text-slate-300" />
              No escalated emails match this filter.
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-slate-200 pt-4 text-xs font-medium text-slate-500">
        <span>
          Displaying <strong className="font-semibold text-slate-900">{filteredQueue.length}</strong> of{" "}
          <strong className="font-semibold text-slate-900">{items.length}</strong> escalated emails
        </span>
        <span className="flex items-center gap-1.5 font-bold tracking-wider text-slate-400 uppercase">
          <Activity className="h-3 w-3" />
          End of Queue
        </span>
      </div>
    </div>
  );
}
