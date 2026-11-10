import { createContext, useContext } from 'react';
import type { Snapshot, ModalState } from './types';
export type LabContext = {
  snapshot: Snapshot; selected: string[]; setSelected: (ids: string[]) => void;
  view: string; setView: (key: string) => void;
  notify: (message: string, error?: boolean) => void;
  run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean>;
  refresh: () => Promise<void>; open: (id: string, groupId?: string) => void;
  showModal: (modal: ModalState) => void;
};
export const Context = createContext<LabContext | null>(null);
export function useLab() { const c = useContext(Context); if (!c) throw new Error('Missing LabCanvas context'); return c; }
