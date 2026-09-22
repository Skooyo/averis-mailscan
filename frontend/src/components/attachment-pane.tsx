import { Download, FileText } from "lucide-react";
import { formatBytes } from "@/lib/format";
import type { AttachmentInfo } from "@/types/averis";

// Kept in sync with the API route's own allowlist (src/app/api/attachments/[attachmentId]/route.ts):
// only these two content types can ever come back with an inline disposition.
const PREVIEWABLE_TYPES = new Set(["text/plain", "application/pdf"]);

/**
 * One SI or BL attachment, shown for human review: the actual document, not just its extracted
 * fields. Previewable types (plain text, PDF) render inline; anything else (xlsx, docx) offers a
 * download instead, since browsers can't display them on their own.
 */
export function AttachmentPane({ label, attachment }: { label: string; attachment: AttachmentInfo | null }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <span className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">{label}</span>
          {attachment && (
            <p className="truncate text-xs font-semibold text-slate-800" title={attachment.filename}>
              {attachment.filename} <span className="font-normal text-slate-400">· {formatBytes(attachment.size)}</span>
            </p>
          )}
        </div>
        {attachment && (
          <a
            href={`/api/attachments/${attachment.id}`}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-[11px] font-bold text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </a>
        )}
      </div>

      {!attachment ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2 p-6 text-center text-slate-400">
          <FileText className="h-8 w-8" />
          <p className="text-xs">No document attached.</p>
        </div>
      ) : PREVIEWABLE_TYPES.has(attachment.contentType) ? (
        <iframe
          src={`/api/attachments/${attachment.id}?view=1`}
          title={`${label}: ${attachment.filename}`}
          className="h-[32rem] w-full bg-white"
        />
      ) : (
        <div className="flex h-64 flex-col items-center justify-center gap-2 p-6 text-center text-slate-500">
          <FileText className="h-8 w-8 text-slate-300" />
          <p className="text-xs">Preview isn&apos;t available for this file type.</p>
          <p className="text-xs">Use Download above to view it.</p>
        </div>
      )}
    </div>
  );
}
