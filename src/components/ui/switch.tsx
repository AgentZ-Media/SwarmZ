import { cn } from "@/lib/utils";

/** Small on/off toggle in the design system's monochrome palette. */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-40",
        checked ? "bg-primary" : "border border-border bg-secondary",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full shadow-sm transition-transform",
          checked ? "translate-x-4 bg-primary-foreground" : "bg-muted-foreground",
        )}
      />
    </button>
  );
}
