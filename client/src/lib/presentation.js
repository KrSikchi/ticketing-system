export function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function friendlyError(error) {
  const reason = error?.payload?.reason || error?.payload?.error;
  const messages = {
    HELD: 'That unit is temporarily held by someone else.',
    SOLD: 'That unit has already been confirmed.',
    NO_HOLD: 'Your hold expired. Choose an available unit to start again.',
    BOOKING_ID_CONFLICT: 'This checkout ID is already in use. Remove the hold and try again.',
    PAYMENT_FAILED: 'The mock payment did not complete. The hold has been released.',
    EXPIRED: 'The 90-second hold expired before checkout completed.',
    FORBIDDEN: 'This checkout belongs to another guest.',
    NO_SESSION: 'The checkout session expired. Please reserve the unit again.',
    RATE_LIMITED: 'A few requests came in too quickly. Pause briefly and try again.',
    SERVICE_UNAVAILABLE: 'The inventory service is temporarily unavailable.',
    NETWORK_ERROR: 'Cannot reach the ticketing API. Check that the backend is running.'
  };
  return messages[reason] || error?.message || 'Something went wrong. Please try again.';
}