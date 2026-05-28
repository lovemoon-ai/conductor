/**
 * MessageBubble: a single message bubble plus the interaction surface that
 * opens the per-message action menu (copy / resend / interrupt / restart).
 *
 * Interaction model is ported from the main app's MessageBubble.tsx:
 *   - Double-click (desktop)            → open menu
 *   - Double-tap (touch / coarse)       → open menu
 *   - Enter / Space when focused        → open menu (keyboard a11y)
 *   - Single tap on coarse pointers     → toggle the timestamp (no hover there)
 *
 * The menu itself is rendered by MessageList (lifted up) so it can paint as a
 * single contained bottom-sheet over the scroll area rather than one popover
 * per bubble. MessageBubble only *requests* the menu via `onRequestMenu`.
 *
 * Layout note: `.conductor-bubble` holds ONLY the message text (so its
 * `textContent` stays equal to the rendered content). The hover/tap timestamp
 * and any attachments are rendered as siblings inside the wrapping
 * `.conductor-bubble-group`, not inside the bubble box.
 */
import { useEffect, useRef, useState } from 'react';
import type { Attachment, Message } from '../../types/message.js';
import type { RenderMessageContent } from './MessageList.js';

export interface MessageBubbleProps {
  message: Message;
  renderMessageContent?: RenderMessageContent;
  /** Called when the user requests the action menu for this message. */
  onRequestMenu: (message: Message) => void;
  /**
   * When true, render a "via {appDisplayName}" chip on messages authored by a
   * third-party app (i.e. `metadata.audit.actor === 'app'`). Hosts embedding
   * the widget in their own app leave this false to avoid a "via <self>"
   * self-reference.
   */
  showAppOriginChip?: boolean;
}

// Max gap between two taps for them to count as a "double tap" on touch
// devices. Matches the main app's value.
const TOUCH_DOUBLE_TAP_MS = 320;

/**
 * Don't hijack double-click / double-tap when the user is interacting with
 * embedded controls (links, media, expandable summaries). Those have their own
 * gestures and opening the action menu over them would be surprising.
 */
const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  Boolean(target.closest('a, button, audio, video, summary, input, textarea, select'));

/** Whether the device lacks hover (so the timestamp is tap-toggled, not hover-revealed). */
const prefersTapTimestamp = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(hover: none), (pointer: coarse)').matches;
};

const formatTime = (dateStr?: string): string => {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value < 1024) {
    return `${Math.max(0, Math.round(value || 0))} B`;
  }
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

// The SDK's Attachment carries a `mimeType` rather than a pre-computed kind;
// derive the render kind here so the public type stays minimal.
const attachmentKind = (att: Attachment): AttachmentKind => {
  const mime = (att.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
};

const getAppOriginName = (message: Message): string | null => {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const audit = (metadata as { audit?: unknown }).audit;
  if (!audit || typeof audit !== 'object') return null;
  const actor = (audit as { actor?: unknown }).actor;
  if (actor !== 'app') return null;
  const name = (audit as { appDisplayName?: unknown }).appDisplayName;
  return typeof name === 'string' && name.trim() ? name.trim() : 'app';
};

export function MessageBubble({
  message,
  renderMessageContent,
  onRequestMenu,
  showAppOriginChip = false,
}: MessageBubbleProps) {
  const lastTouchEndAtRef = useRef(0);
  const [timestampVisible, setTimestampVisible] = useState(false);

  // Reset the tap-toggled timestamp when the row is reused for a new message
  // id (pagination can recycle a row).
  useEffect(() => {
    setTimestampVisible(false);
  }, [message.id]);

  // Default to plain text so consumers without a custom renderer keep the
  // v0.1 behavior.
  const content = renderMessageContent ? renderMessageContent(message) : message.content;
  const attachments = message.attachments ?? [];
  const appOriginName = showAppOriginChip ? getAppOriginName(message) : null;
  const timeText = formatTime(message.createdAt);

  return (
    <div
      className={
        'conductor-bubble-group' +
        (timestampVisible ? ' conductor-bubble-group--timestamp-visible' : '')
      }
    >
      {timeText ? <span className="conductor-bubble__time">{timeText}</span> : null}

      <div
        className="conductor-bubble"
        role="button"
        tabIndex={0}
        onClick={(event) => {
          if (isInteractiveTarget(event.target)) return;
          // Hover-less devices toggle the timestamp on tap; on desktop it's
          // revealed on hover via CSS instead.
          if (prefersTapTimestamp()) {
            setTimestampVisible((current) => !current);
          }
        }}
        onDoubleClick={(event) => {
          if (isInteractiveTarget(event.target)) return;
          onRequestMenu(message);
        }}
        onTouchEnd={(event) => {
          if (isInteractiveTarget(event.target)) {
            lastTouchEndAtRef.current = 0;
            return;
          }
          const now = Date.now();
          if (now - lastTouchEndAtRef.current <= TOUCH_DOUBLE_TAP_MS) {
            lastTouchEndAtRef.current = 0;
            event.preventDefault();
            onRequestMenu(message);
            return;
          }
          lastTouchEndAtRef.current = now;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onRequestMenu(message);
          }
        }}
      >
        {appOriginName ? (
          <span className="conductor-bubble__origin">via {appOriginName}</span>
        ) : null}
        {content}
      </div>

      {attachments.length > 0 ? (
        <div className="conductor-bubble__attachments">
          {attachments.map((att) => {
            const kind = attachmentKind(att);
            return (
              <div key={att.id} className="conductor-attachment" data-kind={kind}>
                {kind === 'image' ? (
                  <a
                    href={att.url}
                    target="_blank"
                    rel="noreferrer"
                    className="conductor-attachment__media-link"
                  >
                    <img src={att.url} alt={att.filename} className="conductor-attachment__image" />
                  </a>
                ) : null}
                {kind === 'video' ? (
                  <video controls preload="metadata" className="conductor-attachment__video" src={att.url} />
                ) : null}
                {kind === 'audio' ? (
                  <audio controls className="conductor-attachment__audio" src={att.url} />
                ) : null}
                {kind === 'file' ? (
                  <a href={att.url} target="_blank" rel="noreferrer" className="conductor-attachment__file">
                    <span className="conductor-attachment__name">{att.filename}</span>
                    <span className="conductor-attachment__size">{formatBytes(att.sizeBytes)}</span>
                  </a>
                ) : (
                  <div className="conductor-attachment__meta">
                    <span className="conductor-attachment__name">{att.filename}</span>
                    <span className="conductor-attachment__size">{formatBytes(att.sizeBytes)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
