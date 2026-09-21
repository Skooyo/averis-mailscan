import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, FileText, GitCompare } from "lucide-react";
import { AutoRefresh } from "@/components/auto-refresh";
import { CategoryBadge, ProcessingBadge } from "@/components/category-badge";
import { ConfidenceBar } from "@/components/confidence-bar";
import { getCurrentUserEmail } from "@/lib/auth";
import { getEmailDetail } from "@/lib/emails";
import { formatBytes, formatSent } from "@/lib/format";

// Read from MongoDB on every request rather than prerendering at build time.
export const dynamic = "force-dynamic";

// `emailId` is the emails collection _id (the email's own `id` repeats across owners).
export default async function Page({ params }: { params: Promise<{ emailId: string }> }) {
  const { emailId } = await params;
  const email = await getEmailDetail(emailId, await getCurrentUserEmail());
  if (!email) notFound();

  const sent = formatSent(email.sentAt);

  return (
    <div className="space-y-6">
      {/* While a sync is classifying this email, re-read it until the result is in. */}
      <AutoRefresh active={email.processing} />
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to inbox
      </Link>

      {/* Header */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight break-words text-slate-900">
              {email.subject === null ? "Subject not stored" : email.subject || "(no subject)"}
            </h1>
            <p className="mt-1 text-xs text-slate-500">{email.id}</p>
          </div>
          {email.category === "comparison_request" && (
            <Link
              href={`/comparison/${email.id}`}
              className="flex h-10 items-center gap-2 rounded-lg bg-red-500 px-4 text-sm font-semibold text-white shadow-sm hover:bg-red-600"
            >
              <GitCompare className="h-4 w-4" />
              View comparison
            </Link>
          )}
        </div>

        <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">From</dt>
            <dd className="mt-1 text-sm font-semibold break-all text-slate-900">{email.from ?? "Not stored"}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">Sent</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-900">{sent ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">Category</dt>
            <dd className="mt-1">
              {email.category ? <CategoryBadge category={email.category} /> : <ProcessingBadge />}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">Confidence</dt>
            <dd className="mt-1">
              {email.processing ? (
                <span className="text-sm text-slate-400">Classifying…</span>
              ) : email.confidence === null ? (
                <span className="text-sm text-slate-400">— (category set at ingest, no classifier score)</span>
              ) : (
                <ConfidenceBar value={email.confidence} />
              )}
            </dd>
          </div>
        </dl>
      </div>

      {/* Body */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <h2 className="flex items-center justify-between gap-3 border-b border-slate-200 px-6 py-4 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
          Message
          {email.live && (
            <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[10px] font-semibold tracking-normal text-sky-700 normal-case">
              Loaded live from Gmail, not stored
            </span>
          )}
        </h2>
        {email.liveError && (
          <p role="alert" className="mx-6 mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {email.liveError === "reauth_required" && (
              <>
                Couldn&apos;t load this email from Gmail because Google access has expired.{" "}
                <a href="/api/auth/google?consent=1" className="font-semibold underline">
                  Reconnect Google
                </a>
              </>
            )}
            {email.liveError === "not_found" && "This email is no longer in your Gmail (it may have been deleted)."}
            {email.liveError === "failed" && "Couldn't load this email from Gmail right now. Try again in a moment."}
          </p>
        )}
        <pre className="px-6 py-5 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-800">
          {email.body !== null
            ? email.body || "(empty)"
            : email.processing
              ? "This email is still being classified. Only shipping-document emails (SI requests and comparison requests) are kept in full, so its message text will appear here if it turns out to be one."
              : email.liveError
                ? ""
                : "The message text isn't stored: only shipping-document emails (SI requests and comparison requests) are kept in full."}
        </pre>
      </div>

      {/* Attachments */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <h2 className="border-b border-slate-200 px-6 py-4 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
          Attachments ({email.attachments.length})
        </h2>
        {email.attachments.length === 0 ? (
          <p className="px-6 py-5 text-sm text-slate-500">No attachments.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {email.attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-4 px-6 py-4">
                <FileText className="h-5 w-5 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{a.filename}</p>
                  <p className="text-xs text-slate-500">{formatBytes(a.size)}</p>
                </div>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold text-slate-600">
                  {a.docType}
                </span>
                <a
                  href={`/api/attachments/${a.id}`}
                  className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Download className="h-4 w-4" />
                  Download
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
