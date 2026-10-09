import { ArrowDownRight, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import Seat from './Seat.jsx';

const FILTERS = [
  { value: 'all', label: 'All units' },
  { value: 'free', label: 'Available' },
  { value: 'held', label: 'On hold' },
  { value: 'sold', label: 'Confirmed' }
];

function InventoryPanel({
  filter, inventory, loading, onFilterChange, onQueryChange, onRefresh,
  onSelectSeat, ownHolds, pendingUnit, query, seats, visibleSeats
}) {
  const counts = inventory?.counts || { free: 0, held: 0, sold: 0 };

  return (
    <section className="inventory-panel" id="inventory" aria-labelledby="inventory-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">EVENT {inventory?.event || '—'}</p>
          <h2 id="inventory-title">Choose a seat</h2>
          <p className="section-subtitle">Select an available unit to start a 90-second hold.</p>
        </div>
        <button className="icon-button refresh-button" type="button" onClick={onRefresh} title="Refresh inventory" aria-label="Refresh inventory">
          <RefreshCw size={16} />
        </button>
      </div>

      <div className="inventory-controls">
        <div className="filter-tabs" role="group" aria-label="Filter units by status">
          {FILTERS.map((item) => (
            <button
              className={`filter-tab${filter === item.value ? ' selected' : ''}`}
              key={item.value}
              onClick={() => onFilterChange(item.value)}
              type="button"
            >
              {item.label}
              <span>{item.value === 'all' ? seats.length : counts[item.value]}</span>
            </button>
          ))}
        </div>
        <label className="search-box">
          <span className="sr-only">Find a unit number</span>
          <input
            inputMode="numeric"
            maxLength={String(inventory?.total || 99999).length}
            onChange={(event) => onQueryChange(event.target.value.replace(/\D/g, ''))}
            placeholder="Find unit"
            value={query}
          />
          <span className="search-hash">#</span>
        </label>
      </div>

      <div className="map-wrap">
        <div className="map-ruler"><span>INVENTORY MAP</span><span>{visibleSeats.length} SHOWN</span></div>
        <div className="map-stage"><span>LIVE SEAT INVENTORY</span></div>
        <div className="column-numbers" aria-hidden="true">
          {Array.from({ length: 10 }, (_, index) => <span key={index}>{String(index + 1).padStart(2, '0')}</span>)}
        </div>
        {loading && seats.length === 0 ? (
          <div className="map-state"><LoaderCircle className="spin" size={21} /> Connecting to inventory…</div>
        ) : seats.length === 0 ? (
          <div className="map-state"><CircleAlert size={19} /> Inventory is unavailable. Check the API and refresh.</div>
        ) : visibleSeats.length === 0 ? (
          <div className="map-state">No units match this view.</div>
        ) : (
          <div className="seat-grid" aria-label="Numbered seat inventory">
            {visibleSeats.map((seat) => (
              <div className="seat-cell" key={seat.unit}>
                <span className="row-letter">{String.fromCharCode(65 + Math.floor((seat.unit - 1) / 10))}</span>
                <Seat
                  seat={seat}
                  owned={ownHolds.has(seat.unit)}
                  pending={pendingUnit === seat.unit}
                  onSelect={onSelectSeat}
                />
              </div>
            ))}
          </div>
        )}
        <div className="legend" aria-label="Seat statuses">
          <span><i className="legend-square available" /> Available</span>
          <span><i className="legend-square selected" /> Your hold</span>
          <span><i className="legend-square held" /> Held</span>
          <span><i className="legend-square sold" /> Confirmed</span>
        </div>
      </div>

      <div className="map-footnote">
        <span><ArrowDownRight size={14} /> Select an available unit to reserve it.</span>
        <span>Inventory updates live</span>
      </div>
    </section>
  );
}

export default InventoryPanel;