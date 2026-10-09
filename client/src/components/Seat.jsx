import { Check } from 'lucide-react';

function Seat({ seat, owned, pending, onSelect }) {
  const label = `Unit ${seat.unit}, ${owned ? 'held by you' : seat.state}`;
  return (
    <button
      aria-label={label}
      aria-pressed={owned}
      className={`seat seat-${owned ? 'mine' : seat.state}${pending ? ' is-pending' : ''}`}
      disabled={pending || (seat.state !== 'free' && !owned)}
      onClick={() => onSelect(seat)}
      title={label}
      type="button"
    >
      {owned ? <Check aria-hidden="true" size={12} strokeWidth={3} /> : seat.unit}
    </button>
  );
}

export default Seat;