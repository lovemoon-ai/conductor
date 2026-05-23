import type { Locator, Page } from "playwright";

/**
 * Lightweight snapshot of the page's interactive elements, modelled after
 * the `ref` concept from Stagehand / agent-browser (RFC §11).
 *
 * Unlike a full accessibility tree, this is a flat list of element
 * descriptors with stable, opaque refs (`e1`, `e2`, ...) that the rest of
 * the system can use to fill / click / extract. The refs survive the
 * lifetime of a Page session but are not persisted.
 */
export interface SnapshotEntry {
  ref: string;
  tag: string;
  role: string | null;
  ariaLabel: string | null;
  placeholder: string | null;
  type: string | null;
  visible: boolean;
  editable: boolean;
  enabled: boolean;
  text: string;
  selector: string;
}

export interface PageSnapshot {
  url: string;
  takenAt: string;
  entries: SnapshotEntry[];
}

/**
 * Collect a coarse snapshot of "things a user / agent might interact with"
 * on the current page. The set of selectors is intentionally simple — it's
 * fed to {@link locator-score} for ranking, not pretty-printed verbatim.
 */
export async function takeSnapshot(page: Page): Promise<PageSnapshot> {
  // We query JS-side so we don't have to round-trip 100s of locator calls.
  const raw = await page.evaluate(() => {
    const SELECTORS = [
      // contenteditable first — ChatGPT's ProseMirror has both a fallback
      // textarea AND the real contenteditable; the contenteditable is what
      // the user actually types into.
      '[contenteditable="true"]',
      '[role="textbox"]',
      "#prompt-textarea",
      "textarea",
      "input[type=text]",
      "button",
      '[role="button"]',
      "[data-message-author-role]",
      "main article",
      ".markdown",
      ".prose",
    ];

    const seen = new Set<Element>();
    const out: Array<Record<string, unknown>> = [];

    function cssPath(el: Element): string {
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        const node: Element = cur;
        let part = node.tagName.toLowerCase();
        if (node.id) {
          part += `#${node.id}`;
          parts.unshift(part);
          break;
        }
        const cls = (node.getAttribute("class") || "")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((c) => `.${CSS.escape(c)}`)
          .join("");
        if (cls) part += cls;
        const parentEl: Element | null = node.parentElement;
        if (parentEl) {
          const siblings: Element[] = Array.from(parentEl.children).filter(
            (s: Element) => s.tagName === node.tagName,
          );
          if (siblings.length > 1) {
            const idx = siblings.indexOf(node) + 1;
            part += `:nth-of-type(${idx})`;
          }
        }
        parts.unshift(part);
        cur = parentEl;
      }
      return parts.join(" > ");
    }

    function isVisible(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.visibility === "hidden" || style.display === "none") return false;
      if (parseFloat(style.opacity) === 0) return false;
      return true;
    }

    for (const sel of SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      nodes.forEach((node) => {
        if (seen.has(node)) return;
        seen.add(node);
        const html = node as HTMLElement;
        out.push({
          tag: html.tagName.toLowerCase(),
          role: html.getAttribute("role"),
          ariaLabel: html.getAttribute("aria-label"),
          placeholder: html.getAttribute("placeholder"),
          type: html.getAttribute("type"),
          visible: isVisible(html),
          editable:
            html.tagName === "TEXTAREA" ||
            (html.tagName === "INPUT" && html.getAttribute("type") !== "hidden") ||
            html.isContentEditable,
          enabled: !(html as HTMLButtonElement).disabled,
          text: (html.innerText || html.textContent || "").trim().slice(0, 240),
          selector: cssPath(html),
        });
      });
    }

    return out;
  });

  const entries: SnapshotEntry[] = raw.map((r, i) => ({
    ref: `e${i + 1}`,
    tag: String(r.tag ?? ""),
    role: (r.role as string | null) ?? null,
    ariaLabel: (r.ariaLabel as string | null) ?? null,
    placeholder: (r.placeholder as string | null) ?? null,
    type: (r.type as string | null) ?? null,
    visible: Boolean(r.visible),
    editable: Boolean(r.editable),
    enabled: Boolean(r.enabled),
    text: String(r.text ?? ""),
    selector: String(r.selector ?? ""),
  }));

  return {
    url: page.url(),
    takenAt: new Date().toISOString(),
    entries,
  };
}

/** Convert a snapshot entry back into a Playwright Locator. */
export function locatorFromEntry(page: Page, entry: SnapshotEntry): Locator {
  return page.locator(entry.selector);
}

/** Human-readable rendering, useful for `chat-web doctor --snapshot`. */
export function formatSnapshot(snap: PageSnapshot): string {
  const lines: string[] = [`URL: ${snap.url}`, `At:  ${snap.takenAt}`, ""];
  for (const e of snap.entries) {
    const bits = [
      `[${e.ref}]`,
      e.tag,
      e.role ? `role=${e.role}` : null,
      e.ariaLabel ? `aria=${JSON.stringify(e.ariaLabel)}` : null,
      e.placeholder ? `placeholder=${JSON.stringify(e.placeholder)}` : null,
      e.visible ? "visible" : "hidden",
      e.editable ? "editable" : null,
      e.enabled ? "enabled" : "disabled",
      e.text ? `text=${JSON.stringify(e.text.slice(0, 60))}` : null,
    ].filter(Boolean);
    lines.push(bits.join(" "));
  }
  return lines.join("\n");
}
