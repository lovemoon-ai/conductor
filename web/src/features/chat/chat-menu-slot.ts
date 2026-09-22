import { createContext } from 'react';

/**
 * Header element the open chat portals its ⋯ menu into. The menu's session
 * actions (schedule, restart, persistent settings) live with ChatView's state,
 * while the button sits in whichever header frames the chat.
 */
export const ChatMenuSlotContext = createContext<HTMLElement | null>(null);
