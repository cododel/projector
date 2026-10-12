import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface WorkspaceMenuItem {
  id?: string;
  label: string;
  disabled?: boolean;
  action?: () => void;
  children?: WorkspaceMenuItem[];
}

/** Operator-only view actions; closing a menu never finishes or discards editors. */
export function WorkspaceMenu({
  label,
  icon,
  disabled,
  items,
  onOpenChange,
}: {
  label: string;
  icon: 'plus' | 'more';
  disabled?: boolean;
  items: WorkspaceMenuItem[];
  onOpenChange?(open: boolean): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 40 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(bounds.left, innerWidth - 238)),
      top: bounds.bottom + 6,
    });
  }, [open, group]);
  const notify = useRef(onOpenChange);
  notify.current = onOpenChange;
  useEffect(() => {
    notify.current?.(open);
    return () => notify.current?.(false);
  }, [open]);
  const close = (restore = false) => {
    setOpen(false);
    setGroup(null);
    if (restore) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, group]);
  const visible = group ? (items.find((item) => item.label === group)?.children ?? []) : items;
  return (
    <div
      className="workspace-menu"
      ref={root}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        } else if (event.key === 'Tab') close();
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const controls = [
            ...(root.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ) ?? []),
          ];
          const current = controls.indexOf(document.activeElement as HTMLButtonElement);
          const index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? controls.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) %
                  controls.length;
          controls[index]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setGroup(null);
          setOpen((value) => !value);
        }}
      >
        <Icon name={icon} />
      </button>
      {open && (
        <div
          className="workspace-actions-menu"
          style={position}
          role="menu"
          aria-label={group ?? label}
        >
          {group && (
            <button role="menuitem" onClick={() => setGroup(null)}>
              Back
            </button>
          )}
          {visible.map((item) => (
            <button
              role="menuitem"
              key={item.id ?? item.label}
              disabled={item.disabled}
              onClick={() => {
                if (item.children) setGroup(item.label);
                else {
                  close(true);
                  item.action?.();
                }
              }}
            >
              {item.label}
            </button>
          ))}
          {group && visible.length === 0 && <p className="muted">No terminals running</p>}
        </div>
      )}
    </div>
  );
}
