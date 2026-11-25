import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import VersionFooter from './VersionFooter';

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="/favicon.svg" alt="" />
          <span>StormWarden</span>
        </div>
        <nav>
          <NavLink to="/" end>Containers</NavLink>
          <NavLink to="/scripts">Scripts</NavLink>
          <NavLink to="/requests">Requests</NavLink>
          <NavLink to="/discord">Discord Bot</NavLink>
          <NavLink to="/users">Users</NavLink>
          <NavLink to="/audit">Audit Log</NavLink>
        </nav>
        <div className="sidebar-footer">
          <div className="user-chip">
            <span className="user-name">{user?.username}</span>
            <span className="role-badge role-admin">admin</span>
          </div>
          <button className="btn btn-ghost" onClick={logout}>Sign out</button>
          <VersionFooter />
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
