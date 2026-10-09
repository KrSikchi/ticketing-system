import { Clock3, Radio, Ticket } from 'lucide-react';
import { formatTime } from '../lib/presentation.js';

function EventPanel({ counts, holds, inventory, nextExpiry, now }) {
  const urgent = holds.length > 0 && nextExpiry - now < 15000;

  return (
    <section className="event-panel" id="top">
      <div className="event-copy">
        <p className="eyebrow"><span>LIVE EVENT</span><span className="eyebrow-separator">/</span><span>SEAT RESERVATION</span></p>
        <h1>Choose your place.</h1>
        <p className="event-description">Browse live inventory and reserve a seat while it is still available.</p>
        <div className="event-meta">
          <span><Radio size={14} /> Event <strong>{inventory?.event || '…'}</strong></span>
          <span><Ticket size={14} /> {inventory?.total ?? '—'} numbered units</span>
        </div>
      </div>
      <div className="hold-clock-panel">
        <div className="clock-topline"><span>YOUR HOLD WINDOW</span><Clock3 size={16} /></div>
        <div className={`clock-value${urgent ? ' urgent' : ''}`}>
          {holds.length ? formatTime(nextExpiry - now) : '01:30'}
        </div>
        <div className="clock-caption">
          {holds.length ? `${holds.length} ${holds.length === 1 ? 'unit is' : 'units are'} reserved` : '90 seconds once a unit is held'}
        </div>
        <div className="event-stats">
          <span><i className="stat-dot free-dot" /> {counts.free} available</span>
          <span><i className="stat-dot held-dot" /> {counts.held} held</span>
          <span><i className="stat-dot sold-dot" /> {counts.sold} confirmed</span>
        </div>
      </div>
    </section>
  );
}

export default EventPanel;