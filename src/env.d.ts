/// <reference types="vite/client" />

interface Window {
  /** Present when the page runs inside the desktop application. */
  labcanvasDesktop?: { platform: string; version: string };
}
