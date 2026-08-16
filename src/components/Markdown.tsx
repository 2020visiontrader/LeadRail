'use client';
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Renders the assistant's markdown output (packet 8.1's compose pass is told to
// use lists and tables, so the UI has to render them).
//
// SECURITY: this content is LLM output whose context includes third-party data
// (lead records, Notion/Drive docs, campaign metadata). It is untrusted.
//   - No raw-HTML passthrough plugin or option is enabled, so raw HTML in the
//     markdown stays escaped — react-markdown's default, deliberately not
//     overridden here.
//   - No direct innerHTML injection anywhere in this component.
//   - urlTransform is react-markdown's built-in `defaultUrlTransform`, which
//     drops any URL whose protocol is not http/https/mailto/tel (so
//     `javascript:` and `data:` links never become clickable hrefs). We do not
//     pass a custom urlTransform, so that default stays in force.
//   - Links open in a new tab with rel="noopener noreferrer".
//
// Streaming: AgentConsole appends `final_delta` chunks character-by-character,
// so this re-renders with partially-formed markdown. remark parses partial
// input fine (an unclosed `**` is just literal text until it closes), and the
// component is memoized on `children` so identical text does not re-parse.

const linkProps = { target: '_blank', rel: 'noopener noreferrer' as const };

function MarkdownImpl({ children }: { children: string }) {
  return (
    <div className="leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              {...linkProps}
              className="text-[var(--brand)] underline underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => <h1 className="mb-2 mt-4 text-base font-semibold text-[var(--text-primary)]">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-4 text-sm font-semibold text-[var(--text-primary)]">{children}</h2>,
          h3: ({ children }) => (
            <h3 className="mb-1 mt-3 text-sm font-semibold text-[var(--text-secondary)]">{children}</h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-[var(--border-strong)] pl-3 text-[var(--text-secondary)]">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-[var(--border-default)]" />,
          // Inline code. Fenced blocks arrive wrapped in <pre>, which we style
          // below; react-markdown passes the same `code` node for both, so the
          // block case keeps its styling from the <pre> wrapper.
          code: ({ children, className }) => (
            <code
              className={
                className
                  ? 'font-mono text-[0.8125rem]'
                  : 'rounded border border-[var(--border-default)] bg-[var(--bg-raised)] px-1 py-0.5 font-mono text-[0.8125rem]'
              }
            >
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] p-3 text-[var(--text-primary)]">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-2 max-w-full overflow-x-auto rounded-lg border border-[var(--border-default)]">
              <table className="w-full border-collapse text-left text-[0.8125rem]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-[var(--bg-raised)]">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-[var(--border-default)] last:border-b-0">{children}</tr>,
          th: ({ children }) => (
            <th className="whitespace-nowrap px-3 py-1.5 font-semibold text-[var(--text-primary)]">{children}</th>
          ),
          td: ({ children }) => <td className="px-3 py-1.5 align-top text-[var(--text-secondary)]">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// Memoized on the text so a re-render of the parent (steps updating, busy
// flipping) does not re-parse unchanged assistant turns.
const Markdown = memo(MarkdownImpl);
export default Markdown;
