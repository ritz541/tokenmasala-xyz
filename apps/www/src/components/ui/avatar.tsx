interface AvatarProps {
  src: string | null;
  alt?: string;
  /** Edge length in pixels. */
  size?: number;
}

/** A square avatar image with a muted fallback when `src` is null. */
function Avatar({ src, alt = "", size = 28 }: AvatarProps) {
  const style = { width: size, height: size };

  if (src === null) {
    return <span className="shrink-0 select-none bg-muted" style={style} />;
  }

  return (
    <img
      alt={alt}
      className="shrink-0 select-none"
      draggable={false}
      loading="lazy"
      src={src}
      style={style}
    />
  );
}

export { Avatar };
