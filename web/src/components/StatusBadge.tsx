export default function StatusBadge({ state }: { state: string }) {
  return (
    <span className={`status-badge status-${state}`}>
      <span className="status-dot" />
      {state.replace('_', ' ')}
    </span>
  );
}
