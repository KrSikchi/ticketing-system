function StatusBar({ counts, health, socketConnected }) {
  const apiIsUp = health?.redis === 'ok';

  return (
    <footer className="statusbar">
      <div className="connection-status">
        <span className={`connection-dot${apiIsUp ? ' online' : ''}`} />
        <strong>{apiIsUp ? 'API connected' : 'API unavailable'}</strong>
        <span className="status-separator">·</span>
        <span>{socketConnected ? 'Live updates connected' : 'Live updates reconnecting'}</span>
      </div>
      <div className="dependency-status">
        <span>Redis <b className={health?.redis === 'ok' ? 'ok' : 'down'}>{health?.redis || '…'}</b></span>
        <span>Postgres <b className={health?.postgres === 'ok' ? 'ok' : 'down'}>{health?.postgres || '…'}</b></span>
        <span>{counts.free} available <span className="status-separator">·</span> {counts.held} held</span>
      </div>
      <div className="contract-links"><span>API</span><code>GET /seats</code><code>POST /hold</code><code>POST /checkout</code><code>POST /pay</code></div>
    </footer>
  );
}

export default StatusBar;