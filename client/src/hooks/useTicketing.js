import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { createBookingId, getOrCreateUserId, request, SOCKET_URL, updateSeatMap } from '../api.js';
import { friendlyError } from '../lib/presentation.js';

export function useTicketing() {
  const [userId] = useState(getOrCreateUserId);
  const [inventory, setInventory] = useState(null);
  const [health, setHealth] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [holds, setHolds] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [pendingUnit, setPendingUnit] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [checkoutStep, setCheckoutStep] = useState(false);
  const [loading, setLoading] = useState(true);

  const refreshInventory = async () => {
    try {
      setInventory(await request('/seats'));
      setLoading(false);
    } catch (error) {
      setLoading(false);
      setNotice({ kind: 'error', text: friendlyError(error) });
    }
  };

  useEffect(() => {
    let mounted = true;
    const loadHealth = async () => {
      try {
        const result = await request('/health');
        if (mounted) setHealth(result);
      } catch (error) {
        if (mounted) setHealth(error.payload || { redis: 'down', postgres: 'down' });
      }
    };

    void refreshInventory();
    void loadHealth();

    const socket = io(SOCKET_URL, { reconnection: true, timeout: 5000 });
    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));
    socket.on('connect_error', () => setSocketConnected(false));
    socket.on('seatmap', (snapshot) => {
      setInventory((current) => ({
        event: snapshot.event,
        total: snapshot.total,
        seats: snapshot.seats,
        counts: current?.counts || { free: 0, held: 0, sold: 0 }
      }));
      setLoading(false);
    });
    socket.on('seat', (changedSeat) => {
      setInventory((current) => updateSeatMap(current, changedSeat));
    });
    socket.on('seatmap_error', () => {
      setNotice({ kind: 'error', text: 'Live inventory is temporarily unavailable.' });
    });

    const inventoryTimer = window.setInterval(() => void refreshInventory(), 5000);
    const healthTimer = window.setInterval(() => void loadHealth(), 10000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000);

    return () => {
      mounted = false;
      window.clearInterval(inventoryTimer);
      window.clearInterval(healthTimer);
      window.clearInterval(clockTimer);
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    const expired = holds.filter((hold) => hold.expiresAt <= now);
    if (expired.length === 0) return;
    const expiredIds = new Set(expired.map((hold) => hold.bookingId));
    setHolds((current) => current.filter((hold) => !expiredIds.has(hold.bookingId)));
    setCheckoutStep(false);
    setNotice({
      kind: 'error',
      text: `${expired.length === 1 ? 'A hold has' : `${expired.length} holds have`} expired and returned to inventory.`
    });
    void refreshInventory();
  }, [now, holds]);

  const ownHolds = useMemo(() => new Map(holds.map((hold) => [hold.unit, hold])), [holds]);
  const seats = inventory?.seats || [];
  const visibleSeats = useMemo(() => seats.filter((seat) => {
    const state = ownHolds.has(seat.unit) ? 'held' : seat.state;
    const matchesFilter = filter === 'all' || state === filter;
    const matchesQuery = query === '' || String(seat.unit).includes(query.trim());
    return matchesFilter && matchesQuery;
  }), [filter, ownHolds, query, seats]);
  const counts = inventory?.counts || { free: 0, held: 0, sold: 0 };
  const nextExpiry = holds.reduce((soonest, hold) => Math.min(soonest, hold.expiresAt), Infinity);
  const readyCount = holds.filter((hold) => hold.phase === 'ready' || hold.phase === 'pending').length;

  const showError = (error) => setNotice({ kind: 'error', text: friendlyError(error) });

  const selectSeat = async (seat) => {
    if (ownHolds.has(seat.unit)) {
      setPendingUnit(seat.unit);
      try {
        await request('/release', { method: 'POST', userId, body: { unit: seat.unit } });
        setHolds((current) => current.filter((hold) => hold.unit !== seat.unit));
        if (holds.length <= 1) setCheckoutStep(false);
        setNotice({ kind: 'success', text: `Unit ${seat.unit} released.` });
      } catch (error) {
        showError(error);
      } finally {
        setPendingUnit(null);
        void refreshInventory();
      }
      return;
    }

    setPendingUnit(seat.unit);
    try {
      const result = await request('/hold', { method: 'POST', userId, body: { unit: seat.unit } });
      setHolds((current) => [...current, {
        unit: seat.unit,
        bookingId: createBookingId(),
        expiresAt: Date.now() + result.expiresInMs,
        phase: 'held'
      }]);
      setCheckoutStep(false);
      setNotice({ kind: 'success', text: `Unit ${seat.unit} held for 90 seconds.` });
    } catch (error) {
      showError(error);
      void refreshInventory();
    } finally {
      setPendingUnit(null);
    }
  };

  const beginCheckout = async () => {
    const unprepared = holds.filter((hold) => hold.phase === 'held');
    if (unprepared.length === 0) {
      setCheckoutStep(readyCount > 0);
      return;
    }

    setBusy('checkout');
    let opened = holds.some((hold) => hold.phase === 'ready' || hold.phase === 'pending');
    for (const hold of unprepared) {
      try {
        await request('/checkout', {
          method: 'POST',
          userId,
          body: { unit: hold.unit, bookingId: hold.bookingId }
        });
        opened = true;
        setHolds((current) => current.map((item) => (
          item.bookingId === hold.bookingId ? { ...item, phase: 'ready' } : item
        )));
      } catch (error) {
        if (error.payload?.reason === 'NO_HOLD') {
          setHolds((current) => current.filter((item) => item.bookingId !== hold.bookingId));
        }
        showError(error);
      }
    }
    setCheckoutStep(opened);
    setBusy('');
    void refreshInventory();
  };

  const payAndConfirm = async () => {
    const pendingPayments = holds.filter((hold) => hold.phase === 'ready' || hold.phase === 'pending');
    if (pendingPayments.length === 0) return;

    setBusy('payment');
    for (const hold of pendingPayments) {
      try {
        const result = await request('/pay', {
          method: 'POST',
          userId,
          body: { bookingId: hold.bookingId }
        });
        if (result.status === 'BOOKED') {
          setHolds((current) => current.filter((item) => item.bookingId !== hold.bookingId));
          setNotice({ kind: 'success', text: `Unit ${result.unit} confirmed.` });
        } else if (result.status === 'PENDING') {
          setHolds((current) => current.map((item) => (
            item.bookingId === hold.bookingId ? { ...item, phase: 'pending' } : item
          )));
          setNotice({ kind: 'error', text: `Payment for unit ${hold.unit} is still processing. Check again shortly.` });
        }
      } catch (error) {
        const reason = error.payload?.reason;
        if (['PAYMENT_FAILED', 'EXPIRED', 'SOLD', 'NO_SESSION'].includes(reason)) {
          setHolds((current) => current.filter((item) => item.bookingId !== hold.bookingId));
        }
        showError(error);
      }
    }
    setBusy('');
    void refreshInventory();
  };

  return {
    beginCheckout,
    busy,
    checkoutStep,
    counts,
    filter,
    health,
    holds,
    inventory,
    loading,
    nextExpiry,
    now,
    notice,
    ownHolds,
    payAndConfirm,
    pendingUnit,
    query,
    readyCount,
    refreshInventory,
    selectSeat,
    setCheckoutStep,
    setFilter,
    setNotice,
    setQuery,
    socketConnected,
    seats,
    visibleSeats
  };
}