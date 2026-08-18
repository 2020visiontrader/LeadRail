'use client';
import AgentConsole from '@/components/AgentConsole';

// Full-height workspace: the heading is fixed, the console takes the rest, and
// only the message list inside it scrolls. Previously the console carried a
// hardcoded viewport-height calc that ignored this heading and <main>'s padding,
// so the whole page overflowed and shifted as you typed.
export default function AssistantPage() {
  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Assistant</h1>
        <p className="text-sm text-[var(--text-secondary)]">Plain-language commands, executed step by step — you approve anything that spends money.</p>
      </div>
      <div className="min-h-0 flex-1">
        <AgentConsole />
      </div>
    </div>
  );
}
