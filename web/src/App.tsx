import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { EventDetailPage } from "./EventDetailPage.tsx";
import { EventsPage } from "./EventsPage.tsx";
import { useEventIdFromHash } from "./route.ts";
import { clearApiKey, loadApiKey, saveApiKey } from "./session.ts";
import { SignIn } from "./SignIn.tsx";

export function App() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState(loadApiKey);
  const [notice, setNotice] = useState<string | null>(null);
  const eventId = useEventIdFromHash();

  const signOut = useCallback(
    (message: string | null) => {
      clearApiKey();
      // Cached events hold payloads, so drop them with the key.
      queryClient.clear();
      setApiKey(null);
      setNotice(message);
    },
    [queryClient],
  );
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

  return (
    <div className="page">
      <header className="top-bar">
        <h1>hookrelay</h1>
        <button type="button" className="secondary" onClick={() => signOut(null)}>
          Sign out
        </button>
      </header>
      <EventsPage apiKey={apiKey} active={eventId === null} onUnauthorized={handleUnauthorized} />
      {eventId !== null && (
        <EventDetailPage key={eventId} apiKey={apiKey} id={eventId} onUnauthorized={handleUnauthorized} />
      )}
    </div>
  );
}
