/**
 * Native glasses bridge.
 *
 * When the web app runs inside the Rokid Android shell (a WebView), the shell injects
 * `window.RokidGlassesNative` (see android/.../bridge/GlassesBridge.kt). This module is the
 * single, typed entry point the web app uses to drive the on-glasses AI_CHAT scene and to
 * receive glasses-button / speech-recognition events.
 *
 * In a normal browser `window.RokidGlassesNative` is absent: `isGlassesShell()` is false and
 * every command here is a no-op, so importing this module is safe everywhere.
 */

export interface GlassDevice {
  name: string;
  mac: string;
}

/** Methods the Android shell exposes on `window.RokidGlassesNative`. */
interface NativeGlasses {
  isPresent: () => boolean;
  listDevices: () => string; // JSON GlassDevice[]
  connect: (mac: string) => void;
  disconnect: () => void;
  isConnected: () => boolean;
  openAiChat: () => void;
  closeScene: () => void;
  showUserText: (text: string) => void;
  notifyThinking: () => void;
  showAiReply: (text: string) => void;
  notifyError: () => void;
  startVoice: () => void;
  stopVoice: () => void;
  setBrightness: (value: number) => void;
  setBackgroundOpacity: (percent: number) => void;
  setFontSize: (sp: number) => void;
  getFontSize: () => number;
  getBrightness: () => number;
  speak: (text: string) => void;
  stopSpeak: () => void;
}

/** Events the shell pushes back into the page via `window.__rokidOn*` callbacks. */
export interface GlassesEvents {
  onGlassStatus?: (connected: boolean, text: string) => void;
  onAiKeyDown?: () => void;
  onAiKeyUp?: () => void;
  onAiExit?: () => void;
  onSttPartial?: (text: string) => void;
  onSttFinal?: (text: string) => void;
  onSttError?: (message: string) => void;
  /** Fired when queued TTS playback finishes (resume listening for the next turn). */
  onSpeakDone?: () => void;
}

type RokidWindow = Window &
  typeof globalThis & {
    RokidGlassesNative?: NativeGlasses;
    __rokidOnGlassStatus?: (connected: boolean, text: string) => void;
    __rokidOnAiKeyDown?: () => void;
    __rokidOnAiKeyUp?: () => void;
    __rokidOnAiExit?: () => void;
    __rokidOnSttPartial?: (text: string) => void;
    __rokidOnSttFinal?: (text: string) => void;
    __rokidOnSttError?: (message: string) => void;
    __rokidOnSpeakDone?: () => void;
  };

function nativeApi(): NativeGlasses | null {
  if (typeof window === 'undefined') return null;
  const api = (window as RokidWindow).RokidGlassesNative;
  try {
    return api && api.isPresent() ? api : null;
  } catch {
    return null;
  }
}

/** True only inside the Android glasses shell. */
export function isGlassesShell(): boolean {
  return nativeApi() !== null;
}

/** Wrap each native call so a thrown bridge error never breaks the web UI. */
function safe<T>(fn: (api: NativeGlasses) => T): T | undefined {
  const api = nativeApi();
  if (!api) return undefined;
  try {
    return fn(api);
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('[glasses] bridge call failed', error);
    }
    return undefined;
  }
}

export const glasses = {
  listDevices(): GlassDevice[] {
    const raw = safe((api) => api.listDevices());
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as GlassDevice[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },
  connect: (mac: string) => void safe((api) => api.connect(mac)),
  disconnect: () => void safe((api) => api.disconnect()),
  isConnected: (): boolean => safe((api) => api.isConnected()) ?? false,
  openAiChat: () => void safe((api) => api.openAiChat()),
  closeScene: () => void safe((api) => api.closeScene()),
  showUserText: (text: string) => void safe((api) => api.showUserText(text)),
  notifyThinking: () => void safe((api) => api.notifyThinking()),
  showAiReply: (text: string) => void safe((api) => api.showAiReply(text)),
  notifyError: () => void safe((api) => api.notifyError()),
  startVoice: () => void safe((api) => api.startVoice()),
  stopVoice: () => void safe((api) => api.stopVoice()),
  setBrightness: (value: number) => void safe((api) => api.setBrightness(value)),
  setBackgroundOpacity: (percent: number) => void safe((api) => api.setBackgroundOpacity(percent)),
  setFontSize: (sp: number) => void safe((api) => api.setFontSize(sp)),
  getFontSize: (): number => safe((api) => api.getFontSize()) ?? 22,
  getBrightness: (): number => safe((api) => api.getBrightness()) ?? 5,
  speak: (text: string) => void safe((api) => api.speak(text)),
  stopSpeak: () => void safe((api) => api.stopSpeak()),
};

// Multiple parts of the UI (e.g. the global connect button and the active chat session) need
// the same shell events at once, so we fan out to a set of listeners instead of letting each
// subscriber overwrite a single window callback.
const listeners = new Set<GlassesEvents>();
let installed = false;

function installDispatchers(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const w = window as RokidWindow;
  const each = <K extends keyof GlassesEvents>(key: K, ...args: unknown[]) => {
    listeners.forEach((l) => {
      const fn = l[key] as ((...a: unknown[]) => void) | undefined;
      if (fn) {
        try {
          fn(...args);
        } catch {
          /* a listener throwing must not break the others */
        }
      }
    });
  };
  w.__rokidOnGlassStatus = (connected, text) => each('onGlassStatus', connected, text);
  w.__rokidOnAiKeyDown = () => each('onAiKeyDown');
  w.__rokidOnAiKeyUp = () => each('onAiKeyUp');
  w.__rokidOnAiExit = () => each('onAiExit');
  w.__rokidOnSttPartial = (text) => each('onSttPartial', text);
  w.__rokidOnSttFinal = (text) => each('onSttFinal', text);
  w.__rokidOnSttError = (message) => each('onSttError', message);
  w.__rokidOnSpeakDone = () => each('onSpeakDone');
}

/**
 * Subscribe to events pushed from the shell. Multiple subscribers coexist; each receives every
 * event. Returns an unsubscribe function. Safe to call in a normal browser (never fires).
 */
export function registerGlassesEvents(handlers: GlassesEvents): () => void {
  if (typeof window === 'undefined') return () => {};
  installDispatchers();
  listeners.add(handlers);
  return () => {
    listeners.delete(handlers);
  };
}

/**
 * Substantive AI output worth showing on the glasses lens (filters agent lifecycle notes).
 * Ported from the original native AppViewModel.isAiReply.
 */
export function isGlassesWorthyReply(role: string, content: string): boolean {
  if (role === 'user' || !content.trim()) return false;
  const c = content.toLowerCase();
  const noise =
    c.includes('session started') ||
    c.includes('session ready') ||
    c.includes('session resumed');
  return !noise;
}
