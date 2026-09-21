'use client';

import React, { useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  Clock,
  Flag,
  RefreshCw,
  ShieldCheck,
  MoreHorizontal,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Maximize2,
  ExternalLink,
  ZoomIn,
  ZoomOut,
  Save,
} from "lucide-react";
import type { ClassifiedEmail } from "@/types/averis";

interface ComparisonScreenProps {
  email: ClassifiedEmail;
  subjectTitle?: string;
}

const fieldGroupMap: Record<string, string> = {
  bl_number: "General Information",
  vessel_name: "General Information",
  shipper: "General Information",
  port_of_loading: "General Information",
  port_of_discharge: "General Information",
  consignee_name: "Consignee & Parties",
  consignee: "Consignee & Parties",
  tax_id: "Consignee & Parties",
  address: "Consignee & Parties",
  notify_party: "Consignee & Parties",
  container_id: "Cargo & Packaging",
  container_count: "Cargo & Packaging",
  gross_weight: "Cargo & Packaging",
  gross_weight_kg: "Cargo & Packaging",
};

const fieldDisplayLabels: Record<string, string> = {
  bl_number: "BL NUMBER",
  vessel_name: "VESSEL NAME",
  shipper: "SHIPPER",
  port_of_loading: "PORT OF LOADING",
  port_of_discharge: "PORT OF DISCHARGE",
  consignee_name: "CONSIGNEE NAME",
  consignee: "CONSIGNEE",
  tax_id: "TAX ID",
  address: "ADDRESS",
  notify_party: "NOTIFY PARTY",
  container_id: "CONTAINER ID",
  container_count: "CONTAINER COUNT",
  gross_weight: "GROSS WEIGHT",
  gross_weight_kg: "GROSS WEIGHT (KG)",
};

export function ComparisonScreen({ email, subjectTitle }: ComparisonScreenProps) {
  const [isFlagged, setIsFlagged] = useState(email.needs_review);
  const [isResolved, setIsResolved] = useState(false);
  const [overrideFromSI, setOverrideFromSI] = useState(false);
  const [notes, setNotes] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(85);

  const fields = email.comparison?.fields ?? [];
  const groups = ["General Information", "Consignee & Parties", "Cargo & Packaging"];
  const mismatches = fields.filter((f) => !f.match);

  const handleSaveNote = () => {
    setNoteSaved(true);
    setTimeout(() => setNoteSaved(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Comparison Detail: {subjectTitle || "BL-9920334"}
            </h1>
          </div>
          <div className="ml-11 mt-1.5 flex items-center gap-3 text-[11px] font-bold text-slate-500 uppercase">
            <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">
              Priority: High
            </span>
            <span className="flex items-center gap-1 normal-case text-slate-400">
              <Clock className="h-3 w-3" />
              Last analyzed 4m ago
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsFlagged(!isFlagged)}
            className={`flex h-9 items-center gap-2 rounded-lg border px-3.5 text-xs font-bold transition-colors ${
              isFlagged
                ? "border-red-200 bg-red-50 text-red-600"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <Flag className="h-3.5 w-3.5" />
            {isFlagged ? "Flagged for Review" : "Flag for Review"}
          </button>

          <button
            type="button"
            onClick={() => setOverrideFromSI(true)}
            disabled={!email.comparison}
            className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {overrideFromSI ? "Updated from SI" : "Update from SI"}
          </button>

          <button
            type="button"
            onClick={() => setIsResolved(true)}
            disabled={!email.comparison}
            className="flex h-9 items-center gap-2 rounded-lg bg-red-500 px-4 text-xs font-bold text-white shadow-sm hover:bg-red-600 active:scale-[0.98] disabled:opacity-50"
          >
            <ShieldCheck className="h-4 w-4" />
            {isResolved ? "All Resolved" : "Resolve All"}
          </button>

          <button
            type="button"
            aria-label="More options"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Mismatch Alert Banner */}
      {(mismatches.length > 0 || email.review_reason) && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50/60 p-4 text-red-900">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          <div className="flex-1">
            <h4 className="text-sm font-bold text-red-700">
              Action Required: Document Mismatches Detected
            </h4>
            <p className="mt-0.5 text-xs text-red-600">
              {email.review_reason?.message || (
                <>
                  We found <strong>{mismatches.length} critical discrepancies</strong> between the
                  Shipping Instruction and Bill of Lading.{" "}
                  <a href="#mismatches" className="underline font-bold hover:text-red-800">
                    Jump to first mismatch
                  </a>
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Comparison Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-7 xl:col-span-8">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {email.comparison ? (
              <table className="w-full text-left" id="mismatches">
                <thead className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
                  <tr>
                    <th className="w-1/4 px-6 py-4">Field Name</th>
                    <th className="w-1/3 px-6 py-4">Shipping Instruction (SI)</th>
                    <th className="w-1/3 px-6 py-4">Bill of Lading (BL)</th>
                    <th className="w-12 px-6 py-4 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {groups.map((section) => {
                    const groupFields = fields.filter(
                      (f) => (fieldGroupMap[f.field] || "Cargo & Packaging") === section
                    );
                    if (groupFields.length === 0) return null;

                    return (
                      <React.Fragment key={section}>
                        <tr className="bg-slate-50/50">
                          <td
                            colSpan={4}
                            className="px-6 py-2.5 text-[10px] font-bold tracking-wider text-slate-500 uppercase"
                          >
                            {section}
                          </td>
                        </tr>

                        {groupFields.map((field) => {
                          const isFieldMatch = isResolved || overrideFromSI ? true : field.match;
                          const effectiveBlValue =
                            overrideFromSI && !field.match ? field.si_value : field.bl_value;
                          const isWarning =
                            field.field === "gross_weight" || field.field === "gross_weight_kg";

                          return (
                            <tr key={field.field} className="transition-colors hover:bg-slate-50/50">
                              <td className="px-6 py-4 font-bold text-slate-600 uppercase">
                                {fieldDisplayLabels[field.field] || field.field}
                              </td>

                              <td className="px-6 py-4 font-mono text-slate-900">{field.si_value}</td>

                              <td className="px-6 py-4">
                                {isFieldMatch ? (
                                  <span className="font-mono text-slate-900">{effectiveBlValue}</span>
                                ) : (
                                  <span
                                    className={`inline-block rounded px-2 py-0.5 font-mono font-bold ${
                                      isWarning
                                        ? "bg-amber-100 text-amber-800"
                                        : "bg-red-100 text-red-700"
                                    }`}
                                  >
                                    {effectiveBlValue}
                                  </span>
                                )}
                              </td>

                              <td className="px-6 py-4 text-center">
                                {isFieldMatch ? (
                                  <CheckCircle2 className="inline h-4 w-4 text-emerald-500" />
                                ) : isWarning ? (
                                  <AlertTriangle className="inline h-4 w-4 text-amber-500" />
                                ) : (
                                  <AlertCircle className="inline h-4 w-4 text-red-500" />
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="p-12 text-center">
                <FileText className="mx-auto h-10 w-10 text-slate-300" />
                <h3 className="mt-3 text-sm font-bold text-slate-800">
                  Document Comparison Unavailable
                </h3>
                <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                  {email.review_reason?.message ||
                    "This document has no companion Bill of Lading file to verify."}
                </p>
              </div>
            )}
          </div>

          {/* Internal Resolution Notes */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-sm font-bold text-slate-900">Internal Resolution Notes</h3>
            <p className="mt-1 text-xs text-slate-500">
              Document all overrides or verification steps taken for compliance auditing.
            </p>

            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Enter verification notes here..."
              rows={4}
              className="mt-4 w-full rounded-lg border border-slate-200 p-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:outline-none"
            />

            <div className="mt-3 flex items-center justify-between">
              {noteSaved && (
                <span className="text-xs font-semibold text-emerald-600">
                  Notes saved successfully!
                </span>
              )}
              <div className="ml-auto">
                <button
                  type="button"
                  onClick={handleSaveNote}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100"
                >
                  <Save className="h-3.5 w-3.5" />
                  Save Note
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Scan Panel */}
        <div className="space-y-4 lg:col-span-5 xl:col-span-4">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-900">Original BL Scan</span>
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
                  VERIFIED_PDF
                </span>
              </div>
              <div className="flex items-center gap-1 text-slate-400">
                <button
                  type="button"
                  aria-label="Maximize scan preview"
                  className="rounded p-1 hover:bg-slate-100 hover:text-slate-600"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Open scan in new tab"
                  className="rounded p-1 hover:bg-slate-100 hover:text-slate-600"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="relative flex min-h-[380px] items-center justify-center bg-slate-100 p-6 overflow-hidden">
              <div
                className="w-full max-w-[280px] rounded-lg border border-slate-200 bg-white p-5 shadow-md transition-transform"
                style={{ transform: `scale(${zoomLevel / 100})` }}
              >
                <div className="border-b border-slate-100 pb-3">
                  <div className="h-3 w-20 rounded bg-slate-300" />
                  <div className="mt-1 h-2 w-32 rounded bg-slate-200" />
                </div>
                <div className="mt-4 space-y-2.5">
                  <div className="h-2 w-full rounded bg-slate-200" />
                  <div className="h-2 w-5/6 rounded bg-slate-200" />
                  <div className="h-2 w-4/6 rounded bg-red-200" />
                  <div className="h-2 w-full rounded bg-slate-200" />
                  <div className="h-2 w-3/4 rounded bg-amber-200" />
                  <div className="h-2 w-5/6 rounded bg-slate-200" />
                </div>
              </div>

              <div className="absolute bottom-4 flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-1 text-xs font-bold text-slate-700 shadow-sm backdrop-blur">
                <button
                  type="button"
                  onClick={() => setZoomLevel((z) => Math.max(50, z - 10))}
                  aria-label="Zoom out"
                  className="hover:text-red-500"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <span>{zoomLevel}%</span>
                <button
                  type="button"
                  onClick={() => setZoomLevel((z) => Math.min(150, z + 10))}
                  aria-label="Zoom in"
                  className="hover:text-red-500"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="border-t border-slate-200 bg-slate-50/50 p-4">
              <h5 className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                Validation Context
              </h5>
              <div className="mt-2 space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">OCR Confidence Score</span>
                  <span className="font-bold text-emerald-600">98.4%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Source File Type</span>
                  <span className="font-semibold text-slate-800">PDF/A (Scanned)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Template Matched</span>
                  <span className="font-mono text-slate-800">Standard_BL_V4</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
