import { createFileRoute } from "@tanstack/react-router";

const Route = createFileRoute("/$user")({
  component: ProfilePage,
});

function ProfilePage() {
  const { user } = Route.useParams();

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{user}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Profile dashboards land with the leaderboard milestone.
      </p>
    </div>
  );
}

export { Route };
