// src/components/stat-card.tsx
import type { LucideIcon } from "lucide-react";

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "primary",
  note,
  onClick,
  active = false,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: "primary" | "success" | "warning" | "info";
  note?: string;
  /** Makes the card a button, e.g. to apply the filter it summarises. */
  onClick?: () => void;
  /** Highlights a clickable card whose filter is currently applied. */
  active?: boolean;
}) {
  const tones = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    info: "bg-info-soft text-info",
  };
  const base = "flex min-h-20 w-full items-center gap-4 rounded-lg border bg-card p-4 text-left shadow-sm";
  const content = (
    <>
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${tones[tone]}`}>
        <Icon size={18} />
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-extrabold uppercase text-muted-foreground">{label}</p>
        <p className="truncate text-xl font-extrabold">{value}</p>
        {note && <p className="text-[10px] text-muted-foreground">{note}</p>}
      </div>
    </>
  );

  if (!onClick) return <div className={`${base} border-border`}>{content}</div>;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${base} cursor-pointer transition-colors hover:bg-slate-50 ${
        active ? "border-warning ring-2 ring-warning/30" : "border-border"
      }`}
    >
      {content}
    </button>
  );
}
