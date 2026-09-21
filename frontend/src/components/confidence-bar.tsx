// src/components/confidence-bar.tsx
export function ConfidenceBar({ value }: { value: number }) {
  const tone = value >= 0.9 ? "bg-success" : value >= 0.7 ? "bg-warning" : "bg-destructive";
  const text = value >= 0.9 ? "text-success" : value >= 0.7 ? "text-warning" : "text-destructive";
  return (
    <div className="w-24">
      <span className={`text-xs font-extrabold ${text}`}>{(value * 100).toFixed(1)}%</span>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${value * 100}%` }} />
      </div>
    </div>
  );
}
