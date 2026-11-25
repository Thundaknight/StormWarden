import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Layout from './components/Layout';
import Audit from './pages/Audit';
import Containers from './pages/Containers';
import Discord from './pages/Discord';
import Login from './pages/Login';
import Requests from './pages/Requests';
import ScriptEditor from './pages/ScriptEditor';
import Scripts from './pages/Scripts';
import Users from './pages/Users';

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="center-screen">Loading…</div>;
  if (!user) return <Login />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Containers />} />
        <Route path="/scripts" element={<Scripts />} />
        <Route path="/scripts/:id" element={<ScriptEditor />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/discord" element={<Discord />} />
        <Route path="/users" element={<Users />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
