'use client';

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft,
  Clock,
  Flag,
  Copy,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Save,
  Pencil,
  X,
} from "lucide-react";
import { AttachmentPane } from "@/components/attachment-pane";
import { RelativeTime } from "@/components/relative-time";
import type { AttachmentInfo, ResultView } from "@/types/averis";

interface ComparisonScreenProps {
  emailId: string;
  subject: string | null;
  /** The email's SI/BL attachments, for the document preview panes below. */
  attachments: AttachmentInfo[];
  /** null when the pipeline hasn't produced a Result for this email yet (see page.tsx). */
  result: ResultView | null;
}

// backend/models.py's 7 canonical fields (backend/comparison.py `FIELDS`).
const FIELD_LABELS: Record<string, string> = {
  shipper: "Shipper",
  consignee: "Consignee",
  notify_party: "Notify Party",
  port_of_loading: "Port of Loading",
  port_of_discharge: "Port of Discharge",
  container_count: "Container Count",
  gross_weight_kg: "Gross Weight (kg)",
};

const STATUS_LABELS: Record<ResultView["status"], string> = {
  match: "Match",
  mismatch: "Mismatch",
  error: "Processing Error",
  skipped: "Not Applicable",
  unclassified: "Unclassified",
};

const STATUS_TONE: Record<ResultView["status"], string> = {
  match: "bg-emerald-100 text-emerald-700",
  mismatch: "bg-red-100 text-red-600",
  error: "bg-red-100 text-red-600",
  skipped: "bg-slate-100 text-slate-600",
  unclassified: "bg-slate-100 text-slate-600",
};

export function ComparisonScreen({ emailId, subject, attachments, result }: ComparisonScreenProps) {
  const router = useRouter();

  // Local-only scratch note -- there's no persisted notes endpoint (unlike field corrections and
  // resolving, below, which do write to Mongo now). Kept as a demo affordance.
  const [notes, setNotes] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);

  const handleSaveNote = () => {
    setNoteSaved(true);
    setTimeout(() => setNoteSaved(false), 2000);
  };

  // Which mismatched field's inline "Correct" form is open, if any.
  const [correctingField, setCorrectingField] = useState<string | null>(null);
  const [correctionValue, setCorrectionValue] = useState("");
  const [correctionNote, setCorrectionNote] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const openCorrection = (field: string, currentBlValue: string | number | null) => {
    setCorrectingField(field);
    setCorrectionValue(currentBlValue != null ? String(currentBlValue) : "");
    setCorrectionNote("");
    setActionError(null);
  };

  const submitCorrection = async (field: string) => {
    setActionPending(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/review/${encodeURIComponent(emailId)}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, value: correctionValue, note: correctionNote || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(body?.error ?? "Correction failed");
        return;
      }
      setCorrectingField(null);
      router.refresh();
    } catch {
      setActionError("Correction failed");
    } finally {
      setActionPending(false);
    }
  };

  const markResolved = async () => {
    setActionPending(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/review/${encodeURIComponent(emailId)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(body?.error ?? "Resolve failed");
        return;
      }
      router.refresh();
    } catch {
      setActionError("Resolve failed");
    } finally {
      setActionPending(false);
    }
  };

  const reasons = result?.escalation.reasons ?? [];
  const mismatches = result?.fields.filter((f) => !f.match) ?? [];
  const duplicateGroups = result?.duplicateAttachments ?? [];

  const siAttachment = attachments.find((a) => a.docType === "SI") ?? null;
  const blAttachment = attachments.find((a) => a.docType === "BL") ?? null;
  // Shown whenever there's something to look at, and also for a comparison_request with a document
  // genuinely missing (its pane then reads "No document attached" -- itself informative for review).
  const showDocuments = attachments.length > 0 || result?.category === "comparison_request";

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
              Comparison Detail: {subject || emailId}
            </h1>
          </div>
          <div className="ml-11 mt-1.5 flex items-center gap-3 text-[11px] font-bold text-slate-500 uppercase">
            <span className="normal-case text-slate-400">{emailId}</span>
            {result && (
              <span className={`rounded px-2 py-0.5 ${STATUS_TONE[result.status]}`}>{STATUS_LABELS[result.status]}</span>
            )}
            {result && (
              <span className="flex items-center gap-1 normal-case text-slate-400">
                <Clock className="h-3 w-3" />
                Processed <RelativeTime iso={result.processedAt} />
              </span>
            )}
          </div>
        </div>

        {result?.escalation.required && (
          <div
            className={`flex h-9 items-center gap-2 rounded-lg border px-3.5 text-xs font-bold ${
              result.escalation.resolved
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-red-200 bg-red-50 text-red-600"
            }`}
          >
            <Flag className="h-3.5 w-3.5" />
            {result.escalation.resolved ? "Escalation Resolved" : "Flagged for Review"}
          </div>
        )}
      </div>

      {!result && (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-sm">
          <FileText className="mx-auto h-10 w-10 text-slate-300" />
          <h3 className="mt-3 text-sm font-bold text-slate-800">Not Yet Processed</h3>
          <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
            This email hasn&apos;t been run through the comparison pipeline yet. Results are written by a
            separate, out-of-band run of{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5">python -m backend.pipeline --write-db</code>.
          </p>
        </div>
      )}

      {result && (
        <>
          {(mismatches.length > 0 || reasons.length > 0) && (
            <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50/60 p-4 text-red-900">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
              <div className="flex-1">
                <h4 className="text-sm font-bold text-red-700">
                  {mismatches.length > 0 ? "Action Required: Document Mismatches Detected" : "Escalated for Review"}
                </h4>
                <p className="mt-0.5 text-xs text-red-600">{result.message}</p>
                {reasons.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-red-700">
                    {reasons.map((r, i) => (
                      <li key={i}>
                        <span className="font-mono font-bold uppercase">{r.code}</span>: {r.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {showDocuments && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <AttachmentPane label="Shipping Instruction (SI)" attachment={siAttachment} />
              <AttachmentPane label="Bill of Lading (BL)" attachment={blAttachment} />
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="space-y-6 lg:col-span-7 xl:col-span-8">
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                {result.fields.length > 0 ? (
                  <table className="w-full text-left">
                    <thead className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
                      <tr>
                        <th className="w-1/4 px-6 py-4">Field</th>
                        <th className="w-1/3 px-6 py-4">Shipping Instruction (SI)</th>
                        <th className="w-1/3 px-6 py-4">Bill of Lading (BL)</th>
                        <th className="w-16 px-6 py-4 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {result.fields.map((f) => (
                        <Fragment key={f.field}>
                          <tr className="transition-colors hover:bg-slate-50/50">
                            <td className="px-6 py-4 font-bold text-slate-600 uppercase">
                              {FIELD_LABELS[f.field] ?? f.field}
                            </td>
                            <td className="px-6 py-4 font-mono text-slate-900">
                              {/* Real value when the Result has one; "Matched" only as a fallback for an
                                  older Result written before compare_documents recorded matched values too. */}
                              {f.siValue ?? (f.match ? <span className="text-slate-400">Matched</span> : "—")}
                            </td>
                            <td className="px-6 py-4">
                              {f.match ? (
                                <span className="font-mono text-slate-900">
                                  {f.blValue ?? <span className="text-slate-400">Matched</span>}
                                </span>
                              ) : (
                                <span className="inline-block rounded bg-red-100 px-2 py-0.5 font-mono font-bold text-red-700">
                                  {f.blValue ?? "—"}
                                </span>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center justify-center gap-2">
                                {f.match ? (
                                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                ) : (
                                  <>
                                    <AlertCircle className="h-4 w-4 text-red-500" />
                                    <button
                                      type="button"
                                      onClick={() =>
                                        correctingField === f.field ? setCorrectingField(null) : openCorrection(f.field, f.blValue)
                                      }
                                      title="Correct this field"
                                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                    >
                                      {correctingField === f.field ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                          {correctingField === f.field && (
                            <tr className="bg-slate-50/80">
                              <td colSpan={4} className="px-6 py-4">
                                <div className="flex flex-wrap items-end gap-3">
                                  <label className="flex-1 min-w-[180px]">
                                    <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">
                                      Correct value
                                    </span>
                                    <input
                                      type="text"
                                      value={correctionValue}
                                      onChange={(e) => setCorrectionValue(e.target.value)}
                                      className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-xs text-slate-900 focus:border-red-500 focus:outline-none"
                                    />
                                  </label>
                                  <label className="flex-1 min-w-[180px]">
                                    <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">
                                      Note (optional)
                                    </span>
                                    <input
                                      type="text"
                                      value={correctionNote}
                                      onChange={(e) => setCorrectionNote(e.target.value)}
                                      placeholder="e.g. checked the original SI"
                                      className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-xs text-slate-900 focus:border-red-500 focus:outline-none"
                                    />
                                  </label>
                                  <button
                                    type="button"
                                    disabled={actionPending}
                                    onClick={() => submitCorrection(f.field)}
                                    className="h-9 shrink-0 rounded-lg bg-red-500 px-4 text-xs font-bold text-white hover:bg-red-600 disabled:opacity-50"
                                  >
                                    {actionPending ? "Saving..." : "Save correction"}
                                  </button>
                                </div>
                                {actionError && <p className="mt-2 text-xs font-semibold text-red-600">{actionError}</p>}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="p-12 text-center">
                    <FileText className="mx-auto h-10 w-10 text-slate-300" />
                    <h3 className="mt-3 text-sm font-bold text-slate-800">No Comparison Data</h3>
                    <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">{result.message}</p>
                  </div>
                )}
              </div>

              {duplicateGroups.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-5 text-xs text-amber-900">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-amber-800">
                    <Copy className="h-4 w-4" />
                    Duplicate Attachments Collapsed
                  </h3>
                  <ul className="mt-2 space-y-1">
                    {duplicateGroups.map((g) => (
                      <li key={g.kept}>
                        <span className="font-mono">{g.kept}</span> kept; dropped as duplicates:{" "}
                        <span className="font-mono">{g.dropped.join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.corrections.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h3 className="text-sm font-bold text-slate-900">Correction History</h3>
                  <ul className="mt-3 space-y-2 text-xs text-slate-600">
                    {result.corrections.map((c, i) => (
                      <li key={i} className="border-b border-slate-100 pb-2 last:border-0">
                        <span className="font-bold text-slate-800">{c.field}</span> {"->"} {String(c.value)}
                        {c.correctedBy && <span className="text-slate-400"> by {c.correctedBy}</span>}
                        {c.note && <p className="mt-0.5 text-slate-500">{c.note}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Internal Resolution Notes -- local scratch pad, not persisted (see the useState comment above). */}
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
                    <span className="text-xs font-semibold text-emerald-600">Notes saved successfully!</span>
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

            {/* Right panel: escalation + result metadata */}
            <div className="space-y-4 lg:col-span-5 xl:col-span-4">
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 px-4 py-3">
                  <span className="text-xs font-bold text-slate-900">Escalation</span>
                </div>

                <div className="p-4 text-xs">
                  {!result.escalation.required ? (
                    <p className="text-slate-500">No escalation required.</p>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        {result.escalation.resolved ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <AlertTriangle className="h-4 w-4 text-amber-500" />
                        )}
                        <span className="font-bold text-slate-800">
                          {result.escalation.resolved ? "Resolved" : "Pending review"}
                        </span>
                      </div>
                      {result.escalation.resolvedBy && (
                        <p className="mt-2 text-slate-500">by {result.escalation.resolvedBy}</p>
                      )}
                      {result.escalation.resolutionNote && (
                        <p className="mt-1 text-slate-500">{result.escalation.resolutionNote}</p>
                      )}
                      <ul className="mt-3 space-y-2">
                        {reasons.map((r, i) => (
                          <li key={i} className="rounded-lg bg-slate-50 p-2.5">
                            <span className="font-mono text-[10px] font-bold uppercase text-slate-500">{r.code}</span>
                            <p className="mt-0.5 text-slate-700">{r.detail}</p>
                          </li>
                        ))}
                      </ul>
                      {!result.escalation.resolved && (
                        <button
                          type="button"
                          disabled={actionPending}
                          onClick={markResolved}
                          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {actionPending ? "Saving..." : "Mark Resolved"}
                        </button>
                      )}
                      {actionError && !correctingField && (
                        <p className="mt-2 text-xs font-semibold text-red-600">{actionError}</p>
                      )}
                      {/* Not implemented -- retry re-runs extraction (real LLM calls) against the
                          original attachment file, which this Vercel-hosted app has no access to.
                          See backend/review.py's retry_email() docstring for what's needed to wire
                          this up (a CLI today; a frontend button later needs a separate Python
                          service plus solving file access). Correct/resolve above are safe to run
                          from here because they're pure document edits. */}
                      <button
                        type="button"
                        disabled
                        title="Not implemented from this UI yet -- retry needs real extraction (LLM calls) against the original attachment file, which this frontend can't reach. Run python -m backend.review retry <email_id> instead (see backend/review.py)."
                        className="mt-2 flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-200 bg-slate-50/50 px-4 py-2 text-xs font-bold text-slate-400"
                      >
                        Retry (not implemented -- use the CLI)
                      </button>
                    </>
                  )}
                </div>

                <div className="border-t border-slate-200 bg-slate-50/50 p-4">
                  <h5 className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">Result</h5>
                  <div className="mt-2 space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Category</span>
                      <span className="font-semibold text-slate-800">{result.category ?? "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Status</span>
                      <span className="font-semibold text-slate-800">{STATUS_LABELS[result.status]}</span>
                    </div>
                    {result.retried && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">Retried</span>
                        <span className="font-semibold text-emerald-700">Yes</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
