import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import VersionFooter from '../components/VersionFooter';

export default function Login() {
  const { login, setup } = useAuth();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.authStatus().then((r) => setNeedsSetup(r.needsSetup)).catch(() => setNeedsSetup(false)); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (needsSetup && password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      if (needsSetup) await setup(username, password);
      else await login(username, password);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (needsSetup === null) return <div className="center-screen">Loading…</div>;
  return (
    <div className="center-screen login-screen">
      <div className="storm-lines" aria-hidden="true" />
      <form className="card login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <img className="brand-logo" src="/favicon.svg" alt="" />
          <span>StormWarden</span>
        </div>
        <p className="muted">{needsSetup ? 'Welcome! Create the owner account to get started.' : 'Sign in to manage StormTower.'}</p>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={needsSetup ? 8 : undefined} /></label>
        {needsSetup && <label>Confirm password<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>}
        {error && <div className="alert alert-error">{error}</div>}
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Please wait…' : needsSetup ? 'Create account' : 'Sign in'}</button>
      </form>
      <VersionFooter />
    </div>
  );
}
