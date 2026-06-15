import type { ReactNode } from "react";

/** Inline code / command snippet. */
function Code({ children }: { children: ReactNode }) {
  return <code className="bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>;
}

export { Code };
