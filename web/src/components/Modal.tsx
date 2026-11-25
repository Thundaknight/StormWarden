import type { ReactNode } from 'react';

export default function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`card modal${wide ? ' modal-wide' : ''}`}>
        <div className="card-head-row">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn btn-ghost btn-small" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
