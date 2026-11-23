/**
 * The one-line text input, styled like `Button` so a form of both looks like one control set.
 *
 * Kept as a component rather than repeated class strings because the settings panel is the
 * only place in the product where a user types a secret: getting the focus ring, the disabled
 * state and `aria-invalid` right once is safer than getting them right in three places.
 */

import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "border-input bg-background h-8 w-full min-w-0 rounded-md border px-2.5 py-1 text-sm shadow-xs transition-[color,box-shadow]",
        "placeholder:text-muted-foreground",
        "focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
