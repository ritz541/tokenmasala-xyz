import { Moon, Sun } from "lucide-react";

/**
 * Flips the `dark` class and persists the choice; the root bootstrap script
 * replays it before paint on the next load.
 */
function ThemeToggle() {
  const toggle = () => {
    const dark = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    localStorage.setItem("tmx.theme", dark ? "dark" : "light");
  };

  return (
    <button
      aria-label="Toggle theme"
      className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:text-foreground"
      onClick={toggle}
      type="button"
    >
      <Sun className="block size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </button>
  );
}

export { ThemeToggle };
