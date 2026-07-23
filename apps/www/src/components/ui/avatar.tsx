const AVATAR_SIZES = {
  sm: 24,
  md: 32,
  lg: 56,
} as const;

type AvatarSize = keyof typeof AVATAR_SIZES | number;

interface AvatarProps {
  src: string | null;
  alt?: string;
  /** Edge length in pixels. */
  size?: AvatarSize;
  /** Eager-load the image (use for above-the-fold avatars). */
  priority?: boolean;
  /** Used to render initials when `src` is null. */
  name?: string | null;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** A square avatar image with a muted fallback when `src` is null. */
function Avatar({ src, alt = "", name, size = 28, priority = false }: AvatarProps) {
  const pixels = typeof size === "number" ? size : AVATAR_SIZES[size];
  const style = { width: pixels, height: pixels };

  if (src === null) {
    return (
      <span
        className="shrink-0 select-none inline-flex items-center justify-center bg-muted text-muted-foreground text-xs font-medium"
        style={style}
      >
        {name ? initials(name) : null}
      </span>
    );
  }

  return (
    <img
      alt={alt}
      className="shrink-0 select-none"
      draggable={false}
      fetchPriority={priority ? "high" : undefined}
      loading={priority ? "eager" : "lazy"}
      src={src}
      style={style}
    />
  );
}

export { Avatar };
