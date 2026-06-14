import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import { Nav } from "../components/nav";
import styles from "../styles.css?url";

/**
 * Runs before first paint: applies the persisted theme (or the system
 * preference) so there is no flash of the wrong theme.
 */
const themeBootstrapScript = `(function () {
  try {
    var stored = localStorage.getItem("tmx.theme");
    var dark = stored === "dark" || (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {}
})();`;

interface RouterContext {
  queryClient: QueryClient;
}

const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "tokenmaxxing" },
      {
        name: "description",
        content: "The social leaderboard for LLM token usage. Sync your agents, climb the ranks.",
      },
      { property: "og:title", content: "tokenmaxxing" },
      {
        property: "og:description",
        content: "The social leaderboard for LLM token usage. Sync your agents, climb the ranks.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://tokenmaxxing.sh" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
    scripts: [{ children: themeBootstrapScript }],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen antialiased">
        <Nav />
        <main className="mx-auto w-full max-w-5xl px-4 pb-16">
          <Outlet />
        </main>
        <Scripts />
      </body>
    </html>
  );
}

export { Route };

export type { RouterContext };
