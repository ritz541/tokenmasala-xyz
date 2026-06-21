import type { CSSProperties, ReactNode } from "react";

/** Inline code / command snippet. */
const codeStyle = {
  fontFeatureSettings: '"liga" 0',
  fontVariantLigatures: "none",
} satisfies CSSProperties;

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="bg-muted px-1.5 py-0.5 font-mono text-xs" style={codeStyle}>
      {children}
    </code>
  );
}

export { Code };
