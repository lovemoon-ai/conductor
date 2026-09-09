'use client';

import { useSyncExternalStore } from 'react';

interface ViewportBounds {
  height: number;
  offsetTop: number;
}

let snapshot: ViewportBounds | undefined;

const getSnapshot = () => {
  const viewport = window.visualViewport;
  // Pinch zoom should not resize or reposition the application.
  const height = viewport?.scale === 1 ? viewport.height : window.innerHeight;
  const offsetTop = viewport?.scale === 1 ? viewport.offsetTop : 0;
  if (!snapshot || snapshot.height !== height || snapshot.offsetTop !== offsetTop) {
    snapshot = { height, offsetTop };
  }
  return snapshot;
};

const subscribe = (onChange: () => void) => {
  const viewport = window.visualViewport;
  window.addEventListener('resize', onChange);
  viewport?.addEventListener('resize', onChange);
  viewport?.addEventListener('scroll', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    viewport?.removeEventListener('resize', onChange);
    viewport?.removeEventListener('scroll', onChange);
  };
};

export function useVisualViewport() {
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}
