'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Textarea from '@/components/Textarea';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';

interface Conversation {
  id: string;
  account_id: string;
  contact_id: string | null;
  channel: string;
  external_thread_id: string;
  subject: string | null;
  status: string;
  last_direction: 'inbound' | 'outbound';
  last_message_at: string;
  unread_count: number;
  created_at: string;
  updated_at: string;
  messages?: Array<{
    id: string;
    conversation_id: string;
    contact_id: string | null;
    channel: string;
    direction: 'inbound' | 'outbound';
    from_addr: string | null;
    to_addr: string | null;
    subject: string | null;
    body: string | null;
    external_id: string | null;
    meta: Record<string, any>;
    is_read: boolean;
    sent_at: string;
  }>;
}

export default function ConversationsPage() {
  const { notify } = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);

  const formatTimestamp = (timestampString: string): string => {
    const date = new Date(timestampString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return 'just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    if (diffInSeconds < 2592000) {
      return `${Math.floor(diffInSeconds / 86400)}d ago`;
    }
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const loadConversations = useCallback(async () => {
    setListLoading(true);
    try {
      const data = await apiGet<Conversation[]>('/api/conversations');
      setConversations(data);
    } catch {
      setConversations([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  const loadConversation = async (id: string) => {
    setDetailLoading(true);
    try {
      const conversation = await apiGet<Conversation>(`/api/conversations/${id}`);
      setActiveConversation(conversation);
    } catch {
      setActiveConversation(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const sendReply = async () => {
    if (!activeConversation || !replyBody.trim()) return;
    setSending(true);
    try {
      await apiSend(`/api/conversations/${activeConversation.id}/reply`, 'POST', { body: replyBody });
      notify('Reply sent');
      setReplyBody('');
      await loadConversation(activeConversation.id);
      await loadConversations();
    } catch (e: any) {
      notify(e.message || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const isLoading = listLoading || detailLoading;

  return (
    <div className="space-y-6">
      {isLoading ? (
        <LoadingSpinner />
      ) : conversations.length === 0 ? (
        <EmptyState icon="💬" title="No conversations" hint="Your conversations will appear here once you start messaging." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <ul className="space-y-2 lg:col-span-1">
            {conversations.map((conv) => (
              <li key={conv.id}>
                <button
                  onClick={() => loadConversation(conv.id)}
                  className={`w-full rounded-lg border p-3 text-left text-sm transition ${
                    activeConversation?.id === conv.id
                      ? 'border-[var(--brand)] bg-[var(--brand-soft)]'
                      : 'border-[var(--border-default)] bg-[var(--bg-surface)] hover:bg-[var(--bg-raised)]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={conv.unread_count > 0 ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}>
                      <Badge>{conv.channel}</Badge>
                    </span>
                  </div>
                  <div className="truncate text-xs text-[var(--text-secondary)]">
                    {conv.subject || '(no subject)'}
                  </div>
                  <div className="text-xs text-[var(--text-muted)]">
                    {formatTimestamp(conv.last_message_at)}
                  </div>
                  {conv.unread_count > 0 && (
                    <div className="flex items-center mt-1">
                      <div className="w-2 h-2 bg-[var(--brand)] rounded-full mr-2" />
                      <span className="text-xs text-[var(--brand)]">{conv.unread_count} unread</span>
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="lg:col-span-2">
            {activeConversation ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
                  <h2 className="text-lg font-semibold mb-2 text-[var(--text-primary)]">
                    {activeConversation.subject || '(no subject)'}
                  </h2>
                  <div className="text-sm text-[var(--text-secondary)]">
                    Channel: {activeConversation.channel}
                  </div>
                  <div className="mt-4 space-y-3">
                    {activeConversation.messages?.map((msg) => (
                      <div
                        key={msg.id}
                        className={`p-4 border rounded-lg ${
                          msg.direction === 'inbound'
                            ? 'border-[var(--border-strong)] bg-[var(--bg-raised)]'
                            : 'border-[var(--border-default)] bg-[var(--bg-surface)]'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-semibold text-[var(--text-primary)]">{msg.from_addr || 'Unknown'}</span>
                          <Badge
                            tone={msg.direction === 'inbound' ? 'blue' : 'gray'}
                          >
                            {msg.direction}
                          </Badge>
                        </div>
                        {msg.subject && (
                          <div className="font-medium mb-1 text-[var(--text-primary)]">{msg.subject}</div>
                        )}
                        <p className="whitespace-pre-wrap text-sm text-[var(--text-secondary)]">
                          {msg.body || '(no body)'}
                        </p>
                        <div className="mt-2 text-xs text-[var(--text-muted)]">
                          {formatTimestamp(msg.sent_at)}
                        </div>
                      </div>
                    ))}
                  </div>
                  {activeConversation.channel === 'instagram' && (
                    <div className="mt-4 space-y-2 border-t border-[var(--border-default)] pt-4">
                      <Textarea
                        label="Reply"
                        rows={3}
                        value={replyBody}
                        onChange={(e) => setReplyBody(e.target.value)}
                      />
                      <Button onClick={sendReply} loading={sending} disabled={!replyBody.trim()}>
                        Send reply
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-[var(--border-strong)] p-10 text-center text-sm text-[var(--text-muted)]">
                Select a conversation
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}