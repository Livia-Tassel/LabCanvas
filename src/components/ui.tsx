import { Component, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';

export type MenuItem =
  | { label: string; onSelect: () => void; shortcut?: string; danger?: boolean; disabled?: boolean; checked?: boolean }
  | 'separator';

type MenuState = { x: number; y: number; items: MenuItem[]; minWidth?: number };
type ConfirmOptions = { title: string; message?: string; confirmLabel?: string; danger?: boolean };
type PromptOptions = {
  title: string;
  message?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** The text that has to be typed before the action can be confirmed. */
  require?: string;
};
type Toast = { id: number; message: string; error?: boolean; action?: { label: string; run: () => void } };

type Overlay = {
  menu: (at: { x: number; y: number } | HTMLElement, items: MenuItem[]) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  toast: (message: string, options?: { error?: boolean; action?: Toast['action'] }) => void;
};

const OverlayContext = createContext<Overlay | null>(null);

export function useOverlay() {
  const overlay = useContext(OverlayContext);
  if (!overlay) throw new Error('OverlayProvider is missing');
  return overlay;
}

/** Gives focus back to whatever had it before an overlay opened. */
function useRestoreFocus() {
  // Read while rendering: by the time effects run, an autofocused field inside the overlay already has focus.
  const previous = useRef(document.activeElement as HTMLElement | null);
  // A layout effect, so that focus returns before an overlay opened by the same action places its own.
  useLayoutEffect(() => () => {
    if (previous.current?.isConnected) previous.current.focus?.({ preventScroll: true });
  }, []);
}

function MenuView({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: state.x, top: state.y });
  const [active, setActive] = useState(-1);
  useRestoreFocus();
  // Keep the menu inside the window once its size is known.
  useLayoutEffect(() => {
    const box = ref.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(6, Math.min(state.x, window.innerWidth - box.width - 6)),
      top: Math.max(6, Math.min(state.y, window.innerHeight - box.height - 6))
    });
    setActive(-1);
    ref.current!.focus();
  }, [state]);

  const usable = (index: number) => {
    const item = state.items[index];
    return item !== undefined && item !== 'separator' && !item.disabled;
  };
  const step = (from: number, direction: 1 | -1) => {
    const count = state.items.length;
    for (let n = 1; n <= count; n++) {
      const index = (from + direction * n + count * 2) % count;
      if (usable(index)) return index;
    }
    return -1;
  };
  const choose = (index: number) => {
    const item = state.items[index];
    if (!usable(index) || item === 'separator') return;
    onClose();
    item.onSelect();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    const key = event.key;
    if (key === 'Escape' || key === 'Tab') { event.preventDefault(); onClose(); }
    else if (key === 'ArrowDown') { event.preventDefault(); setActive(step(active, 1)); }
    else if (key === 'ArrowUp') { event.preventDefault(); setActive(step(active < 0 ? 0 : active, -1)); }
    else if (key === 'Home') { event.preventDefault(); setActive(step(-1, 1)); }
    else if (key === 'End') { event.preventDefault(); setActive(step(0, -1)); }
    else if (key === 'Enter' || key === ' ') { event.preventDefault(); choose(active); }
    else if (key.length === 1) {
      // Typing a character jumps to the next item that starts with it.
      const needle = key.toLowerCase();
      const count = state.items.length;
      for (let n = 1; n <= count; n++) {
        const index = (Math.max(active, -1) + n) % count;
        const item = state.items[index];
        if (usable(index) && item !== 'separator' && item.label.toLowerCase().startsWith(needle)) { setActive(index); break; }
      }
    }
  };
  useEffect(() => {
    ref.current?.querySelector('.menu-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="overlay-backdrop" onPointerDown={onClose} onContextMenu={event => { event.preventDefault(); onClose(); }}>
      <div
        ref={ref}
        className="menu"
        role="menu"
        tabIndex={-1}
        style={{ ...position, minWidth: state.minWidth }}
        onPointerDown={event => event.stopPropagation()}
        onPointerLeave={() => setActive(-1)}
        onKeyDown={onKeyDown}
      >
        {state.items.map((item, index) =>
          item === 'separator' ? (
            <div key={index} className="menu-separator" role="separator" />
          ) : (
            <button
              key={index}
              role="menuitem"
              aria-checked={item.checked}
              tabIndex={-1}
              className={`menu-item${item.danger ? ' danger' : ''}${index === active ? ' active' : ''}`}
              disabled={item.disabled}
              onPointerMove={() => { if (active !== index) setActive(index); }}
              onClick={() => choose(index)}
            >
              <span className="menu-check">{item.checked && <Check size={13} />}</span>
              <span className="menu-label">{item.label}</span>
              {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
            </button>
          )
        )}
      </div>
    </div>
  );
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, children, onClose, width = 420 }: { title: string; children: ReactNode; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useRestoreFocus();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.contains(document.activeElement)) dialog.focus();
  }, []);
  // Tab stays inside the dialog.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const items = Array.from(ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(item => item.offsetParent !== null);
    if (!items.length) return event.preventDefault();
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === ref.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
  };
  return (
    <div className="overlay-backdrop dim" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} style={{ width }} onKeyDown={onKeyDown}>
        <div className="dialog-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="dialog-actions">{children}</div>;
}

function ConfirmDialog({ options, resolve }: { options: ConfirmOptions; resolve: (value: boolean) => void }) {
  return (
    <Dialog title={options.title} onClose={() => resolve(false)} width={380}>
      {options.message && <p className="dialog-message">{options.message}</p>}
      <DialogActions>
        <button className="button" autoFocus={options.danger} onClick={() => resolve(false)}>取消</button>
        <button className={`button ${options.danger ? 'danger' : 'primary'}`} autoFocus={!options.danger} onClick={() => resolve(true)}>
          {options.confirmLabel ?? '确定'}
        </button>
      </DialogActions>
    </Dialog>
  );
}

function PromptDialog({ options, resolve }: { options: PromptOptions; resolve: (value: string | null) => void }) {
  const [value, setValue] = useState(options.value ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const ready = options.require === undefined ? value.trim() !== '' : value.trim() === options.require;
  return (
    <Dialog title={options.title} onClose={() => resolve(null)} width={380}>
      {options.message && <p className="dialog-message">{options.message}</p>}
      <form onSubmit={event => { event.preventDefault(); if (ready) resolve(value.trim()); }}>
        <label className="field">
          {options.label && <span>{options.label}</span>}
          <input ref={input} className="input" autoFocus value={value} placeholder={options.placeholder} onChange={event => setValue(event.target.value)} />
        </label>
        <DialogActions>
          <button type="button" className="button" onClick={() => resolve(null)}>取消</button>
          <button type="submit" className={`button ${options.danger ? 'danger' : 'primary'}`} disabled={!ready}>{options.confirmLabel ?? '确定'}</button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirmState, setConfirm] = useState<{ options: ConfirmOptions; resolve: (value: boolean) => void } | null>(null);
  const [promptState, setPrompt] = useState<{ options: PromptOptions; resolve: (value: string | null) => void } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => setToasts(list => list.filter(toast => toast.id !== id)), []);
  const overlay = useMemo<Overlay>(() => ({
    menu(at, items) {
      if (at instanceof HTMLElement) {
        const box = at.getBoundingClientRect();
        setMenu({ x: box.left, y: box.bottom + 4, items, minWidth: Math.max(180, box.width) });
      } else {
        setMenu({ ...at, items });
      }
    },
    confirm: options => new Promise(resolve => setConfirm({ options, resolve: value => { setConfirm(null); resolve(value); } })),
    prompt: options => new Promise(resolve => setPrompt({ options, resolve: value => { setPrompt(null); resolve(value); } })),
    toast(message, options = {}) {
      const id = ++counter.current;
      setToasts(list => [...list.slice(-2), { id, message, ...options }]);
      setTimeout(() => dismiss(id), options.error ? 8000 : options.action ? 6000 : 3000);
    }
  }), [dismiss]);

  return (
    <OverlayContext.Provider value={overlay}>
      {children}
      {menu && <MenuView state={menu} onClose={() => setMenu(null)} />}
      {confirmState && <ConfirmDialog {...confirmState} />}
      {promptState && <PromptDialog {...promptState} />}
      <div className="toasts" aria-live="polite">
        {toasts.map(toast => (
          <div key={toast.id} className={`toast${toast.error ? ' error' : ''}`}>
            <span>{toast.message}</span>
            {toast.action && <button className="toast-action" onClick={() => { dismiss(toast.id); toast.action!.run(); }}>{toast.action.label}</button>}
            <button className="icon-button small" aria-label="关闭" onClick={() => dismiss(toast.id)}><X size={12} /></button>
          </div>
        ))}
      </div>
    </OverlayContext.Provider>
  );
}

/**
 * Keeps a failure in one part of the window from blanking all of it.
 * With `onReset` the failed part can be closed; otherwise the window is reloaded.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { onReset } = this.props;
    return (
      <div className="welcome crash" role="alert">
        <p>界面出现错误，资料库中的数据不受影响。</p>
        <p className="muted selectable">{this.state.error.message}</p>
        {onReset
          ? <button className="button" onClick={() => { onReset(); this.setState({ error: null }); }}>关闭</button>
          : <button className="button" onClick={() => window.location.reload()}>重新载入</button>}
      </div>
    );
  }
}
