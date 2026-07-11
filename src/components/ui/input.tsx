import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-8 w-full select-text rounded-md border border-line bg-card px-3 py-1 text-13 text-txt transition-colors placeholder:text-fnt focus-visible:border-acc/55 focus-visible:outline-none",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

/** Form section label — the reference's mono uppercase micro-label. */
export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      "mb-2 block font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt",
      className,
    )}
    {...props}
  />
));
Label.displayName = "Label";
