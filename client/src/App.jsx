import EventPanel from './components/EventPanel.jsx';
import InventoryPanel from './components/InventoryPanel.jsx';
import ReservationPanel from './components/ReservationPanel.jsx';
import StatusBar from './components/StatusBar.jsx';
import Toast from './components/Toast.jsx';
import TopBar from './components/TopBar.jsx';
import { useTicketing } from './hooks/useTicketing.js';

function App() {
  const ticketing = useTicketing();

  return (
    <main className="page-shell">
      <TopBar holdCount={ticketing.holds.length} />
      <EventPanel
        counts={ticketing.counts}
        holds={ticketing.holds}
        inventory={ticketing.inventory}
        nextExpiry={ticketing.nextExpiry}
        now={ticketing.now}
      />
      <div className="content-grid">
        <InventoryPanel
          filter={ticketing.filter}
          inventory={ticketing.inventory}
          loading={ticketing.loading}
          onFilterChange={ticketing.setFilter}
          onQueryChange={ticketing.setQuery}
          onRefresh={() => void ticketing.refreshInventory()}
          onSelectSeat={ticketing.selectSeat}
          ownHolds={ticketing.ownHolds}
          pendingUnit={ticketing.pendingUnit}
          query={ticketing.query}
          seats={ticketing.seats}
          visibleSeats={ticketing.visibleSeats}
        />
        <ReservationPanel
          busy={ticketing.busy}
          checkoutStep={ticketing.checkoutStep}
          holds={ticketing.holds}
          nextExpiry={ticketing.nextExpiry}
          now={ticketing.now}
          onBeginCheckout={() => void ticketing.beginCheckout()}
          onPayAndConfirm={() => void ticketing.payAndConfirm()}
          onRelease={ticketing.selectSeat}
          onSetCheckoutStep={ticketing.setCheckoutStep}
          readyCount={ticketing.readyCount}
        />
      </div>
      <StatusBar
        counts={ticketing.counts}
        health={ticketing.health}
        socketConnected={ticketing.socketConnected}
      />
      <Toast notice={ticketing.notice} onDismiss={() => ticketing.setNotice(null)} />
    </main>
  );
}

export default App;