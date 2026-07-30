'use client';
import { useRef, useEffect, useState, type ReactNode } from 'react';
import Button from '@/components/Button';

export interface ChatMsg { role: 'user' | 'assistant'; content: string }

// Reusable multi-turn chat surface. Presentational + controlled: the parent
// owns the message list and the send handler (which calls the AI route and
// appends the assistant reply). Enter sends; Shift+Enter makes a newline.
export default function ChatAssistant({
  messages, onSend, loading, placeholder = 'Type a message…', emptyHint, minHeight = 220,
}: {
  messages: ChatMsg[];
  onSend: (text: string) => void;
  loading?: boolean;
  placeholder?: string;
  emptyHint?: ReactNode;
  minHeight?: number;
}) {
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);

  const submit = () => { const t = text.trim(); if (!t || loading) return; onSend(t); setText(''); };

  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white">
      <div className="flex-1 space-y-2 overflow-y-auto p-3" style={{ minHeight, maxHeight: 400 }}>
        {messages.length === 0 && emptyHint && <div className="text-sm text-slate-400">{emptyHint}</div>}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-800'}`}>{m.content}</div>
          </div>
        ))}
        {loading && <div className="flex justify-start"><div className="rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-400">Thinking…</div></div>}
        <div ref={endRef} />
      </div>
      <div className="flex items-end gap-2 border-t border-slate-200 p-2">
        <textarea
          rows={2}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          className="flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        />
        <Button loading={loading} onClick={submit}>Send</Button>
      </div>
    </div>
  );
}
