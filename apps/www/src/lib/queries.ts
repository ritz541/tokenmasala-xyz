import { queryOptions } from "@tanstack/react-query";

import { runApi } from "./api";

/**
 * queryOptions for every server read — components compose these with
 * useQuery/useMutation; query keys are the single source of cache identity.
 */

const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => runApi((client) => client.me.me()),
  retry: false,
  staleTime: 60_000,
});

const devicesQuery = queryOptions({
  queryKey: ["me", "devices"],
  queryFn: () => runApi((client) => client.me.listDevices()),
});

const tokensQuery = queryOptions({
  queryKey: ["me", "tokens"],
  queryFn: () => runApi((client) => client.me.listTokens()),
});

export { devicesQuery, meQuery, tokensQuery };
