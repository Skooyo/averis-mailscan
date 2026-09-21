// src/components/category-badge.tsx
import type { EmailCategory } from "@/types/averis";

const categoryLabels: Record<EmailCategory, string> = {
  comparison_request: "Comparison Request",
  new_si_request: "New SI Request",
  invoice_query: "Invoice Query",
  general: "General",
  spam: "Spam",
};

const styles: Record<EmailCategory, string> = {
  comparison_request: "border-info/20 bg-info-soft text-info",
  new_si_request: "border-purple-200 bg-purple-50 text-purple-700",
  invoice_query: "border-warning/30 bg-warning-soft text-warning",
  general: "border-border bg-muted text-muted-foreground",
  spam: "border-destructive/30 bg-destructive/5 text-destructive",
};

export function CategoryBadge({ category }: { category: EmailCategory }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-semibold ${styles[category]}`}>
      {categoryLabels[category]}
    </span>
  );
}
