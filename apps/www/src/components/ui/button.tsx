import type { ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

type ButtonVariant = "primary" | "outline" | "ghost" | "destructive";
type ButtonSize = "xs" | "sm" | "md" | "icon";

interface ButtonStyleProps {
  variant?: ButtonVariant;
  /** Adds padding. Omit for a bare text-link button. */
  size?: ButtonSize;
  fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "font-medium bg-foreground text-background transition-opacity hover:opacity-85 disabled:opacity-50",
  outline:
    "border border-border bg-background font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50",
  ghost: "text-muted-foreground transition-colors hover:text-foreground",
  destructive: "text-red-500 transition-colors hover:underline disabled:opacity-50",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-7 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5",
  sm: "px-3 py-1.5",
  md: "px-4 py-2",
  icon: "p-1.5",
};

/**
 * Returns the className for a button-styled element. Use this directly on
 * `<Link>`/`<a>` so they can borrow the styling; use `<Button>` for native
 * buttons.
 */
function buttonClassName({ variant = "primary", size, fullWidth }: ButtonStyleProps = {}): string {
  return cn(
    "inline-flex items-center justify-center gap-2 text-sm",
    VARIANTS[variant],
    size && SIZES[size],
    fullWidth && "w-full",
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleProps {}

function Button({ variant, size, fullWidth, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      className={cn(buttonClassName({ variant, size, fullWidth }), className)}
      type={type}
      {...rest}
    />
  );
}

export { Button, buttonClassName };
