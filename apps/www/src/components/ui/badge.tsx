import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

type BadgeVariant = "muted" | "accent";

const VARIANTS: Record<BadgeVariant, string> = {
  muted: "bg-muted text-muted-foreground",
  accent: "bg-accent text-accent-foreground",
};

/** A small label/tag. */
function Badge({ variant = "muted", children }: { variant?: BadgeVariant; children: ReactNode }) {
  return (
    <span
      className={cn("inline-flex items-center px-2 py-0.5 text-xs font-medium", VARIANTS[variant])}
    >
      {children}
    </span>
  );
}

export { Badge };
export type { BadgeVariant };
