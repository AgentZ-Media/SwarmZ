import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-20 w-full resize-y rounded-md border border-border bg-secondary/60 px-3 py-2 text-sm text-foreground placeholder:text-faint focus-visible:outline-none focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/25 transition-colors select-text",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
