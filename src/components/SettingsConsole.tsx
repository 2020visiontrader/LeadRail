'use client';
import { useState, ReactNode } from 'react';

// No icon-library dependency here (lucide-react is not installed in this
// package.json and this pass may not add one) — `icon` accepts any ReactNode,
// so a consumer can pass a lucide icon, inline SVG, or nothing.
function ChevronGlyph({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
      className={`shrink-0 transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}
    >
      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// SettingsConsole — operator-settings shell: a left-rail grouped nav tree
// (Providers / Models / Personas / Skills / MCP / Cron / Env, and similar)
// + a content pane on the right. Modeled on the adclaw console's
// Control/Agent/Settings sidebar groups, expressed with LeadRail's existing
// tokens and primitives only — no new component library, no adclaw code.
//
// Usage — a settings page mounts its section list + active content:
//
//   const groups: SettingsGroup[] = [
//     { id: 'agent', label: 'Agent', items: [
//       { id: 'providers', label: 'Providers', icon: <Plug size={14} /> },
//       { id: 'models', label: 'Models', icon: <Box size={14} /> },
//       { id: 'personas', label: 'Personas', icon: <Users size={14} /> },
//       { id: 'skills', label: 'Skills', icon: <Sparkles size={14} /> },
//       { id: 'mcp', label: 'MCP', icon: <Cable size={14} /> },
//     ]},
//     { id: 'ops', label: 'Operations', items: [
//       { id: 'cron', label: 'Cron', icon: <CalendarClock size={14} /> },
//       { id: 'env', label: 'Environment', icon: <Globe size={14} /> },
//     ]},
//   ];
//
// `icon` is a plain ReactNode (no lucide-react dependency in this primitive
// itself) — pass a lucide-react icon if the consuming page already has it
// installed, or any inline SVG/emoji.
//
//   <SettingsConsole groups={groups} activeId={active} onSelect={setActive}>
//     {active === 'providers' && <ProvidersPanel />}
//     ...
//   </SettingsConsole>

export interface SettingsItem {
  id: string;
  label: string;
  /** Any small (~14px) glyph — inline SVG, lucide icon, or emoji. Optional. */
  icon?: ReactNode;
  badge?: ReactNode;
}

export interface SettingsGroup {
  id: string;
  label: string;
  items: SettingsItem[];
}

interface SettingsConsoleProps {
  groups: SettingsGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  children: ReactNode;
  /** Optional heading rendered above the content pane (e.g. active item label). */
  title?: string;
  /** Optional description under the title, max ~640px per DESIGN.md section header rule. */
  description?: string;
  /** Optional right-aligned actions next to the title (e.g. a primary button). */
  actions?: ReactNode;
}

export default function SettingsConsole({
  groups,
  activeId,
  onSelect,
  children,
  title,
  description,
  actions,
}: SettingsConsoleProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (id: string) =>
    setCollapsedGroups((g) => ({ ...g, [id]: !g[id] }));

  return (
    <div className="flex min-h-[560px] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
      <nav
        aria-label="Settings sections"
        className="console-rail-scroll flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-4"
      >
        {groups.map((group) => {
          const collapsed = !!collapsedGroups[group.id];
          return (
            <div key={group.id}>
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                className="flex w-full items-center justify-between px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] transition hover:text-[var(--text-secondary)]"
              >
                <span>{group.label}</span>
                <ChevronGlyph collapsed={collapsed} />
              </button>
              {!collapsed && (
                <div className="mt-1 flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const active = item.id === activeId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onSelect(item.id)}
                        aria-current={active ? 'true' : undefined}
                        className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition ${
                          active
                            ? 'font-semibold text-[var(--ink)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
                        }`}
                        style={active ? { background: 'color-mix(in srgb, var(--ink) 15%, transparent)' } : undefined}
                      >
                        {item.icon && <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{item.icon}</span>}
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.badge}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {(title || actions) && (
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border-default)] px-6 py-4">
            <div>
              {title && <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>}
              {description && (
                <p className="mt-1 max-w-[640px] text-[13px] text-[var(--text-secondary)]">{description}</p>
              )}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
        )}
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
