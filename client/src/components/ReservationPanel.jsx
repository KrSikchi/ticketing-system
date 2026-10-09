import { ArrowRight, Check, LoaderCircle, ShieldCheck, Ticket, X } from 'lucide-react';
import { formatTime } from '../lib/presentation.js';

function ReservationPanel({
  busy, checkoutStep, holds, nextExpiry, now, onBeginCheckout, onPayAndConfirm,
  onRelease, onSetCheckoutStep, readyCount
}) {
  const hasPendingPayment = holds.some((hold) => hold.phase === 'pending');
  const busyLabel = busy === 'checkout' ? 'Opening checkout…' : busy === 'payment' ? 'Confirming…' : '';

  return (
    <aside className="reservation-panel" id="reservation" aria-labelledby="reservation-title">
      <div className="reservation-heading">
        <div>
          <p className="eyebrow">YOUR SESSION</p>
          <h2 id="reservation-title">Reservation</h2>
        </div>
        {holds.length > 0 && <span className="timer-pill">{formatTime(nextExpiry - now)}</span>}
      </div>

      {holds.length === 0 ? (
        <div className="empty-reservation">
          <span className="empty-icon"><Ticket size={19} /></span>
          <strong>No seats selected</strong>
          <p>Choose an available numbered unit to reserve it.</p>
        </div>
      ) : (
        <div className="reservation-list">
          {holds.map((hold) => {
            const remaining = hold.expiresAt - now;
            return (
              <div className="reservation-item" key={hold.bookingId}>
                <div className="reservation-item-main">
                  <span className="reservation-seat-icon"><Ticket size={14} /></span>
                  <div>
                    <strong>Unit {hold.unit}</strong>
                    <small>{hold.phase === 'held' ? 'Held for you' : hold.phase === 'pending' ? 'Payment processing' : 'Checkout ready'}</small>
                  </div>
                </div>
                <span className={`item-time${remaining < 15000 ? ' urgent' : ''}`}>{formatTime(remaining)}</span>
                <button
                  className="remove-button"
                  disabled={busy !== ''}
                  onClick={() => void onRelease({ unit: hold.unit, state: 'held' })}
                  type="button"
                  aria-label={`Release unit ${hold.unit}`}
                  title="Release unit"
                >
                  <X size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="reservation-summary">
        <div><span>Units selected</span><strong>{holds.length}</strong></div>
        <div><span>Reservation total</span><strong className="no-price">No price data</strong></div>
      </div>

      <div className="checkout-actions">
        {!checkoutStep ? (
          <button className="primary-button" disabled={holds.length === 0 || busy !== ''} onClick={onBeginCheckout} type="button">
            {busy === 'checkout' ? <LoaderCircle className="spin" size={16} /> : null}
            Continue to checkout <ArrowRight size={16} />
          </button>
        ) : (
          <>
            <div className="checkout-note"><ShieldCheck size={15} /><span>Mock checkout · no payment details collected</span></div>
            <button className="primary-button" disabled={readyCount === 0 || busy !== ''} onClick={onPayAndConfirm} type="button">
              {busy === 'payment' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              {busyLabel || (hasPendingPayment ? 'Check payment' : 'Pay & confirm')}
            </button>
            <button className="secondary-button" disabled={busy !== ''} onClick={() => onSetCheckoutStep(false)} type="button">Back to seats</button>
          </>
        )}
      </div>

      <div className="secure-note"><ShieldCheck size={14} /><span>Seat inventory is secured by the live reservation service.</span></div>
      <p className="guest-note">Guest session <span>·</span> No account required</p>
    </aside>
  );
}

export default ReservationPanel;