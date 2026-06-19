import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import { Footer } from "../components/footer";
import { Nav } from "../components/nav";
import styles from "../styles.css?url";

interface RouterContext {
  queryClient: QueryClient;
}

const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "tokenmaxxing.sh" },
      {
        name: "description",
        content: "The social leaderboard for LLM token usage. Sync your agents, climb the ranks.",
      },
      { property: "og:title", content: "tokenmaxxing.sh" },
      {
        property: "og:description",
        content: "The social leaderboard for LLM token usage. Sync your agents, climb the ranks.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://tokenmaxxing.sh" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen antialiased">
        <Nav />
        <main className="mx-4 max-w-5xl border-x border-border lg:mx-auto">
          <Outlet />
        </main>
        <Footer />
        <Scripts />
      </body>
    </html>
  );
}

export { Route };

export type { RouterContext };
