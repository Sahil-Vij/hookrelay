import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { EventsPage } from "./EventsPage.tsx";
import { clearApiKey, loadApiKey, saveApiKey } from "./session.ts";
import { SignIn } from "./SignIn.tsx";

export function App() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState(loadApiKey);
  const [notice, setNotice] = useState<string | null>(null);

  const signOut = useCallback(
    (message: string | null) => {
      clearApiKey();
      // Cached events hold payload metadata, so drop them with the key.
      queryClient.clear();
      setApiKey(null);
      setNotice(message);
    },
    [queryClient],
  );
  const handleSignOut = useCallback(() => signOut(null), [signOut]);
  const handleUnauthorized = useCallback(() => signOut("Your API key was rejected. Sign in again."), [signOut]);

  if (!apiKey) {
    return (
      <SignIn
        notice={notice}
        onSignIn={(key) => {
          saveApiKey(key);
          setNotice(null);
          setApiKey(key);
        }}
      />
    );
  }
  return <EventsPage apiKey={apiKey} onSignOut={handleSignOut} onUnauthorized={handleUnauthorized} />;
}
