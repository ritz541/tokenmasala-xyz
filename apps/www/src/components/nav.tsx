import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";

import { signOut } from "../lib/api";
import { meQueryOptions } from "../lib/queries";
import { Avatar } from "./ui/avatar";
import { Button, buttonClassName } from "./ui/button";

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-4 flex h-14 max-w-5xl items-center justify-between border-x border-border px-4 lg:mx-auto">
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
        <UserMenu />
      </div>
    </header>
  );
}

function UserMenu() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery(meQueryOptions);
  const signout = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  if (me.isPending) {
    return <Avatar size={28} src={null} />;
  }

  if (me.isError) {
    return (
      <Link className={buttonClassName({ variant: "primary", size: "sm" })} to="/login">
        Sign in
      </Link>
    );
  }

  const user = me.data.user;

  return (
    <div className="flex items-center gap-3">
      <Link className="flex items-center gap-2" params={{ user: user.login }} to="/$user">
        <Avatar alt={user.login} size={28} src={user.avatarUrl} />
      </Link>
      <Link className="text-sm text-muted-foreground hover:text-foreground" to="/settings">
        Settings
      </Link>
      <Button onClick={() => signout.mutate()} variant="ghost">
        Sign out
      </Button>
    </div>
  );
}

export { Nav };
