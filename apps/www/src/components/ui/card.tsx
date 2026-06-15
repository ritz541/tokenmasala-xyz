import type { HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {}

/** A surface container: bordered card on the card background. Default padding
 * is `p-4`; pass `className` (e.g. `"p-6"`) to override. */
function Card({ className, ...rest }: CardProps) {
  return <div className={cn("border border-border bg-card", className ?? "p-4")} {...rest} />;
}

export { Card };
