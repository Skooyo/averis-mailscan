'use client';

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldAlert,
  Clock,
  CheckCircle2,
  Users,
  Search,
  Filter,
  ChevronDown,
  ChevronUp,
  FileText,
  UserCheck,
  Check,
  Activity,
} from "lucide-react";
import { reviewQueue } from "../data/averis-data";
import { StatCard } from "@/components/stat-card";

type TabFilter = "all" | "high" | "requiresReview";

export function ReviewScreen() {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>("REV-9402");
  const [queueActionsOpen, setQueueActionsOpen] = useState(false);
  const [assignedReviewers, setAssignedReviewers] = useState<Record<string, string>>({});

  const filteredQueue = useMemo(() => {
    return reviewQueue.filter((item) => {
      if (activeTab === "high" && item.priority !== "high") return false;
      if (activeTab === "requiresReview" && !item.requiresReview) return false;
      const text = `${item.id} ${item.reference} ${item.issue} ${item.assignee}`.toLowerCase();
      return text.includes(searchQuery.toLowerCase());
    });
  }, [activeTab, searchQuery]);

  const handleAssign = (id: string) => {
    setAssignedReviewers((prev) => ({
      ...prev,
      [id]: prev[id] === "Auditor (Me)" ? "Marcus Chen" : "Auditor (Me)",
    }));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Review</h1>
          <p className="mt-1 text-sm text-slate-500">
            Audit and resolve discrepancies in high-priority freight documents.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
            {(
              [
                ["all", "All (4)"],
                ["high", "High Priority (2)"],
                ["requiresReview", "Requires Review (2)"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setActiveTab(value)}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors ${
                  activeTab === value
                    ? "bg-red-500 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            aria-label="Filter options"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"
          >
            <Filter className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Urgent Actions" value="Critical Path" icon={ShieldAlert} tone="warning" />
        <StatCard label="Avg. Review Time" value="42m 15s" icon={Clock} tone="warning" />
        <StatCard label="Accuracy Rate" value="99.2%" icon={CheckCircle2} tone="success" />
        <StatCard label="Active Reviewers" value="8 Online" icon={Users} tone="info" />
      </div>

      <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by reference, carrier, or ship name..."
            className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50/50 pl-9 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:bg-white focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-4">
          <div className="text-xs font-medium text-slate-500">
            Sort: <span className="font-bold text-slate-900">Priority (High-Low)</span>
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setQueueActionsOpen(!queueActionsOpen)}
              className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold tracking-wider text-slate-700 uppercase shadow-sm hover:bg-slate-50"
            >
              Queue Actions
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {queueActionsOpen && (
              <div className="absolute right-0 top-10 z-20 w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    alert("Queue auto-assigned.");
                    setQueueActionsOpen(false);
                  }}
                  className="w-full px-4 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Auto-Assign Queue
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {filteredQueue.map((item) => {
          const isExpanded = expandedId === item.id;
          const currentAssignee = assignedReviewers[item.id] || item.assignee;

          return (
            <div
              key={item.id}
              className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all"
            >
              <button
                type="button"
                onClick={() => setExpandedId(isExpanded ? null : item.id)}
                className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-slate-50/60"
              >
                <div className="flex items-center gap-4">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                      item.priority === "high"
                        ? "border border-red-200 bg-red-50 text-red-500"
                        : "border border-slate-200 bg-slate-100 text-slate-600"
                    }`}
                  >
                    <ShieldAlert className="h-5 w-5" />
                  </div>

                  <div>
                    <span className="font-bold text-slate-900">{item.id}</span>
                    <span
                      className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                        item.priority === "high"
                          ? "bg-red-100 text-red-600"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {item.priority} Priority
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-8 text-xs">
                  <div>
                    <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                      Reference
                    </span>
                    <span className="flex items-center gap-1 font-semibold text-slate-900">
                      <FileText className="h-3 w-3 text-red-400" />
                      {item.reference}
                    </span>
                  </div>

                  <div className="w-48">
                    <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                      Issue Description
                    </span>
                    <span className="truncate font-semibold text-slate-900">{item.issue}</span>
                  </div>

                  <div className="w-28 text-right">
                    <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                      Assignee
                    </span>
                    <span className="font-semibold text-slate-900">{currentAssignee}</span>
                  </div>

                  <div className="w-24 text-right">
                    <span className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                      Pending Time
                    </span>
                    <span className="flex items-center justify-end gap-1 font-semibold text-slate-700">
                      <Clock className="h-3 w-3 text-slate-400" />
                      {item.pending}
                    </span>
                  </div>

                  <div className="text-slate-400">
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-slate-100 bg-slate-50/70 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="max-w-2xl">
                      <h4 className="text-xs font-bold tracking-wider text-slate-500 uppercase">
                        Review Context &amp; Discrepancy Reason
                      </h4>
                      <p className="mt-1 text-sm font-medium text-slate-800">
                        {item.issue}: Discrepancies detected between the declared Shipping Instruction
                        and Bill of Lading scan. Requires manual auditor sign-off.
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleAssign(item.id)}
                        className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50"
                      >
                        <UserCheck className="h-3.5 w-3.5" />
                        {currentAssignee === "Auditor (Me)" ? "Reassign" : "Assign to Me"}
                      </button>

                      <button
                        type="button"
                        onClick={() => router.push(`/comparison/${item.emailId}`)}
                        className="flex h-9 items-center gap-2 rounded-lg bg-red-500 px-4 text-xs font-bold text-white shadow-sm hover:bg-red-600 active:scale-[0.98]"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Open Comparison
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 pt-4 text-xs font-medium text-slate-500">
        <span>
          Displaying <strong className="font-semibold text-slate-900">{filteredQueue.length}</strong> of{" "}
          <strong className="font-semibold text-slate-900">{reviewQueue.length}</strong> active tasks
        </span>
        <span className="flex items-center gap-1.5 font-bold tracking-wider text-slate-400 uppercase">
          <Activity className="h-3 w-3" />
          End of Queue
        </span>
      </div>
    </div>
  );
}
