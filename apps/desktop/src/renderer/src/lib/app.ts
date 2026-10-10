import { QueryClient } from "@tanstack/react-query";
import { API_URL } from "../../../shared/config";
import { createSession } from "./session";

// The app's singletons. REST data goes through TanStack Query (from 9b on) using `session.client.request`.
export const queryClient = new QueryClient();
export const session = createSession({
  baseUrl: API_URL,
  storage: window.loop.session,
  onSignedOut: () => queryClient.clear(),
});
