import { Check, CircleAlert, X } from 'lucide-react';

function Toast({ notice, onDismiss }) {
  if (!notice) return null;

  return (
    <div className={`toast toast-${notice.kind}`} role="status">
      {notice.kind === 'success' ? <Check size={16} /> : <CircleAlert size={16} />}
      <span>{notice.text}</span>
      <button aria-label="Dismiss message" onClick={onDismiss} type="button"><X size={15} /></button>
    </div>
  );
}

export default Toast;