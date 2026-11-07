import { useState, type FormEvent } from "react";
import { listEvents, UnauthorizedError } from "./api.ts";

interface Props {
  notice: string | null;
  onSignIn: (apiKey: string) => void;
}

export function SignIn({ notice, onSignIn }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = apiKey.trim();
    setPending(true);
    setError(null);
    try {
      // Check the key against the API before keeping it, so a typo fails here and not on the next screen.
      await listEvents(key, { limit: 1 });
      onSignIn(key);
    } catch (err) {
      setError(err instanceof UnauthorizedError ? "That key was rejected." : "Couldn't reach the server. Is it running?");
      setPending(false);
    }
  }

  return (
    <main className="sign-in">
      <h1>hookrelay</h1>
      <form onSubmit={handleSubmit} className="card">
        <h2>Sign in</h2>
        {notice && <p className="notice">{notice}</p>}
        <label htmlFor="api-key">API key</label>
        <input
          id="api-key"
          name="api-key"
          type={showKey ? "text" : "password"}
          autoComplete="current-password"
          spellCheck={false}
          autoCapitalize="off"
          enterKeyHint="done"
          required
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          aria-describedby={error ? "api-key-error" : "api-key-hint"}
          aria-invalid={error ? true : undefined}
        />
        <p id="api-key-hint" className="hint">
          The value of <code>HOOKRELAY_API_KEY</code> on the server.
        </p>
        <label className="checkbox">
          <input type="checkbox" checked={showKey} onChange={(e) => setShowKey(e.target.checked)} />
          Show key
        </label>
        {error && (
          <p id="api-key-error" className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
