import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import VersionFooter from '../components/VersionFooter';

export default function Login() {
  const { login, setup, loginWithToken } = useAuth();
  const [status, setStatus] = useState<{ needsSetup: boolean; discordLogin: boolean; passwordLogin: boolean } | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.authStatus().then(setStatus).catch(() => setStatus({ needsSetup: false, discordLogin: false, passwordLogin: true }));
    const params = new URLSearchParams(window.location.search);
    const token = params.get('discordToken');
    const err = params.get('discordError');
    if (token || err) window.history.replaceState({}, '', window.location.pathname);
    if (token) loginWithToken(token).catch((e) => setError(e.message));
    else if (err) setError(err);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (status?.needsSetup && password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      if (status?.needsSetup) await setup(username, password);
      else await login(username, password);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <div className="center-screen">Loading…</div>;
  const showPassword = status.needsSetup || status.passwordLogin;
  return (
    <div className="center-screen login-screen">
      <div className="storm-lines" aria-hidden="true" />
      <form className="card login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <img className="brand-logo" src="/favicon.svg" alt="" />
          <span>StormWarden</span>
        </div>
        <p className="muted">{status.needsSetup ? 'Welcome! Create the owner account to get started.' : 'Sign in to manage StormTower.'}</p>
        {showPassword && (
          <>
            <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required /></label>
            <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={status.needsSetup ? 8 : undefined} /></label>
            {status.needsSetup && <label>Confirm password<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>}
          </>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {showPassword && <button className="btn btn-primary" disabled={busy}>{busy ? 'Please wait…' : status.needsSetup ? 'Create account' : 'Sign in'}</button>}
        {status.discordLogin && !status.needsSetup && (
          <>
            {showPassword && <div className="login-divider"><span>or</span></div>}
            <button type="button" className="btn btn-discord" onClick={() => { window.location.href = '/api/auth/discord/login'; }}>
              Sign in with Discord
            </button>
            <p className="hint" style={{ textAlign: 'center' }}>Only Discord accounts linked to a StormWarden user can sign in.</p>
          </>
        )}
      </form>
      <VersionFooter />
    </div>
  );
}
