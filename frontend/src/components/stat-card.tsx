// src/components/stat-card.tsx
import type { LucideIcon } from "lucide-react";

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "primary",
  note,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: "primary" | "success" | "warning" | "info";
  note?: string;
}) {
  const tones = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    info: "bg-info-soft text-info",
  };
  return (
    <div className="flex min-h-20 items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm">
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${tones[tone]}`}>
        <Icon size={18} />
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-extrabold uppercase text-muted-foreground">{label}</p>
        <p className="truncate text-xl font-extrabold">{value}</p>
        {note && <p className="text-[10px] text-muted-foreground">{note}</p>}
      </div>
    </div>
  );
}
