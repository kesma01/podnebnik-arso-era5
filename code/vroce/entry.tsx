import { render } from "solid-js/web";
import { QueryClientProvider, QueryClient } from "@tanstack/solid-query";
import { AliJeVroceERA5 } from "/code/vroce/AliJeVroceERA5.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 1000 * 60 * 5, gcTime: 1000 * 60 * 60 },
  },
});

const root = document.getElementById("vroce");
if (root) {
  render(
    () => (
      <QueryClientProvider client={queryClient}>
        <AliJeVroceERA5 />
      </QueryClientProvider>
    ),
    root
  );
}
