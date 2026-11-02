import { useEffect, useRef, useState } from 'react';

/** Sign-in screen shown before anything else loads (when APP_PASSWORD is set). */
export default function Login({ onDone, expired }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(expired ? 'Your session ended. Please sign in again.' : '');
  const input = useRef(null);
  useEffect(() => input.current?.focus(), []);

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', password, remember }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (!j.ok) throw new Error(j.error || 'Sign-in failed');
      setPassword('');
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
      input.current?.select();
    }
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 32 32">
              <path d="M6 22l6-7 5 4 9-11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="brand-name">Stock Hits</span>
        </div>
        <h1>Sign in</h1>
        <p className="muted">This dashboard is private.</p>
        <label className="login-field">
          <span>Password</span>
          <span className="login-pw">
            <input
              ref={input}
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(error)}
            />
            <button type="button" className="link" onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>
          </span>
        </label>
        <label className="switch login-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Keep me signed in on this device for 30 days</span>
        </label>
        {error && <p className="status err" role="alert">{error}</p>}
        <button className="btn primary login-btn" type="submit" disabled={!password || busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
