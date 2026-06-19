import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { Gear, SignOut, User } from "@phosphor-icons/react/ssr";

import { signOut } from "../lib/api";
import { meQueryOptions } from "../lib/queries";
import { Avatar } from "./ui/avatar";
import { buttonClassName } from "./ui/button";
import { Menu } from "./ui/menu";

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-4 flex h-14 max-w-5xl items-center justify-between border-x border-border px-4 lg:mx-auto">
        <div className="flex items-baseline gap-6">
          <Link className="text-sm font-semibold tracking-tight" to="/">
            tokenmaxxing.sh
          </Link>
          <Link
            activeProps={{ className: "text-foreground" }}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
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
    <Menu>
      <Menu.Trigger className="flex outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <Avatar alt={user.login} size={28} src={user.avatarUrl} />
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item icon={<User />} render={<Link params={{ user: user.login }} to="/$user" />}>
          Profile
        </Menu.Item>
        <Menu.Item icon={<Gear />} render={<Link to="/settings" />}>
          Settings
        </Menu.Item>
        <Menu.Separator />
        <Menu.Item
          className="text-red-500 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-500"
          icon={<SignOut />}
          onClick={() => signout.mutate()}
        >
          Sign out
        </Menu.Item>
      </Menu.Content>
    </Menu>
  );
}

export { Nav };
