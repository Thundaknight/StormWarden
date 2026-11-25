import { useEffect, useState } from 'react';
import { api } from '../api';

export default function VersionFooter() {
  const [version, setVersion] = useState('');
  useEffect(() => { api.authStatus().then((r) => setVersion(r.version)).catch(() => {}); }, []);
  return version ? <div className="version-footer muted">StormWarden v{version}</div> : null;
}
