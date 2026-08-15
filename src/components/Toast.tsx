import { useState, useEffect } from 'react';

interface ToastProps {
  message: string;
  type: 'success' | 'error' | 'info';
  duration?: number;
}

export default function Toast({ message, type, duration = 3000 }: ToastProps) {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(false), duration);
    return () => clearTimeout(timer);
  }, [duration]);

  if (!isVisible) return null;

  const bg = {
    success: 'var(--status-positive)',
    error: 'var(--status-negative)',
    info: 'var(--ink)',
  }[type];
  const fg = type === 'info' ? 'var(--ink-fg)' : '#FFFFFF';

  return (
    <div
      className="fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 text-sm font-medium shadow-op-3"
      style={{ background: bg, color: fg }}
    >
      {message}
    </div>
  );
}