import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";

import { signOut } from "../lib/api";
import { meQuery } from "../lib/queries";
import { ThemeToggle } from "./theme-toggle";

function Nav() {
  return (
    <header className="mb-10 border-b border-border">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
        <div className="flex items-baseline gap-6">
          <Link
            className="font-mono text-sm font-semibold tracking-tight"
            search={{ metric: "spend", window: "all" }}
            to="/"
          >
            tokenmaxxing
          </Link>
          <Link
            activeProps={{ className: "text-foreground" }}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            search={{ metric: "spend", window: "all" }}
            to="/"
          >
            Leaderboard
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

function UserMenu() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const signout = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  if (me.isPending) {
    return <div className="size-7 rounded-full bg-muted" />;
  }

  if (me.isError) {
    return (
      <Link
        className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-85"
        to="/login"
      >
        Sign in
      </Link>
    );
  }

  const user = me.data.user;

  return (
    <div className="flex items-center gap-3">
      <Link className="flex items-center gap-2" params={{ user: user.login }} to="/$user">
        {user.avatarUrl === null ? (
          <div className="size-7 rounded-full bg-muted" />
        ) : (
          <img alt={user.login} className="size-7 rounded-full" src={user.avatarUrl} />
        )}
      </Link>
      <Link className="text-sm text-muted-foreground hover:text-foreground" to="/settings">
        Settings
      </Link>
      <button
        className="text-sm text-muted-foreground hover:text-foreground"
        onClick={() => signout.mutate()}
        type="button"
      >
        Sign out
      </button>
    </div>
  );
}

export { Nav };
