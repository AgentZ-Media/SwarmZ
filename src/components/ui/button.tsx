import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Vibe v3 buttons. `default` is the accent CTA ("where I am" — New agent,
 * Start, Send); `confirm` is the light-on-dark hard-confirm move ("Allow");
 * `danger` the solid destructive CTA (close-confirms); `secondary`/`ghost`/
 * `outline` recede onto the surface ladder.
 */
const buttonVariants = cva(
  "inline-flex cursor-default select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-13 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc/40 disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-acc font-semibold text-white hover:brightness-110",
        confirm: "bg-txt font-semibold text-bg hover:brightness-90",
        secondary: "border border-line bg-pop text-txt hover:border-line2",
        ghost: "text-mut hover:bg-card hover:text-txt",
        danger: "bg-err font-semibold text-white hover:brightness-110",
        outline: "border border-line2 bg-transparent text-txt hover:bg-pop",
      },
      size: {
        default: "h-8 px-4",
        sm: "h-7 px-3 text-12",
        icon: "h-8 w-8",
        xs: "h-6 w-6 text-12",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
