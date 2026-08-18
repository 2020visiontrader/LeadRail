'use client';
import AgentConsole from '@/components/AgentConsole';

export default function AssistantPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Assistant</h1>
        <p className="text-sm text-[var(--text-secondary)]">Plain-language commands, executed step by step — you approve anything that spends money.</p>
      </div>
      <AgentConsole />
    </div>
  );
}
