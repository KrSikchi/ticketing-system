const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || undefined;

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.message || payload?.reason || payload?.error || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export async function request(path, { method = 'GET', userId, body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (userId) headers['x-user-id'] = userId;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(0, { error: 'NETWORK_ERROR', message: 'Cannot reach the ticketing API.' });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

export function updateSeatMap(current, changedSeat) {
  if (!current || !changedSeat || !Number.isInteger(Number(changedSeat.unit))) return current;
  const unit = Number(changedSeat.unit);
  const seats = current.seats.map((seat) => (
    seat.unit === unit ? { ...seat, state: changedSeat.state } : seat
  ));
  const counts = { free: 0, held: 0, sold: 0 };
  for (const seat of seats) counts[seat.state] += 1;
  return { ...current, seats, counts };
}

export function getOrCreateUserId() {
  const key = 'ticketing-guest-id';
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const id = `guest-${window.crypto.randomUUID()}`;
    window.localStorage.setItem(key, id);
    return id;
  } catch {
    return `guest-${window.crypto.randomUUID()}`;
  }
}

export function createBookingId() {
  return window.crypto.randomUUID();
}