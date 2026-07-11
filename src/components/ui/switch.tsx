import { cn } from "@/lib/utils";

/** Small on/off toggle — accent track when on (the Vibe v3 reference toggle). */
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
        "relative h-[17px] w-[30px] shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc/40 disabled:pointer-events-none disabled:opacity-40",
        checked ? "bg-acc" : "bg-line2",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-1/2 h-[13px] w-[13px] -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform",
          checked && "translate-x-[13px]",
        )}
      />
    </button>
  );
}
