import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";

/**
 * Quiet badge. Defaults to a neutral outline chip; pass `color` only when a
 * piece of data genuinely needs an identity hue (kept low-alpha by design).
 */
export function Badge({
  className,
  color,
  children,
}: {
  className?: string;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line bg-pop/50 px-2 py-0.5 text-10 font-medium leading-none text-mut",
        className,
      )}
      style={
        color
          ? {
              borderColor: `color-mix(in srgb, ${color} 25%, transparent)`,
              backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
              color,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}

export const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("relative overflow-hidden", className)}
    {...props}
  >
    {/* Radix wraps children in a `display: table; min-width: 100%` div that
        sizes to its content, so long unbreakable text grows past the viewport
        and `truncate` never kicks in — force it to block/full-width. */}
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit] [&>div]:!block [&>div]:w-full">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar
      orientation="vertical"
      className="flex touch-none select-none p-0.5 transition-colors"
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-line2" />
    </ScrollAreaPrimitive.Scrollbar>
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = "ScrollArea";

export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-card p-3">
      <div className="truncate font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
        {label}
      </div>
      <div
        className="mt-1 truncate font-mono text-16 font-semibold tabular-nums tracking-[-0.01em]"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 truncate text-12 text-mut">
          {sub}
        </div>
      )}
    </div>
  );
}
