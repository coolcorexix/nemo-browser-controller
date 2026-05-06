// Functions injected into the page (isolated world) via chrome.scripting.executeScript.
// They must be self-contained — no closures over background-side state.
// State that needs to persist across calls is hung off `window.__nemo` in the
// isolated world (state lives per frame, per extension).

export function snapshotDom() {
  const INTERACTIVE_TAGS = new Set([
    "a", "button", "input", "textarea", "select",
    "label", "details", "summary", "option",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
    "tab", "checkbox", "radio", "switch", "textbox", "combobox",
    "searchbox", "option", "treeitem",
  ]);

  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.hasAttribute("tabindex") && el.tabIndex >= 0) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function accessibleName(el) {
    const label = el.getAttribute("aria-label");
    if (label) return label.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const ref = document.getElementById(labelledby);
      if (ref) return ref.innerText.trim().slice(0, 120);
    }
    if (el.tagName === "INPUT" && el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.innerText.trim().slice(0, 120);
    }
    const alt = el.getAttribute("alt");
    if (alt) return alt.trim();
    const title = el.getAttribute("title");
    if (title) return title.trim();
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return `(placeholder) ${placeholder.trim()}`;
    const text = (el.innerText || el.textContent || "").trim();
    return text.slice(0, 120);
  }

  function describe(el, ref) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const name = accessibleName(el);
    const value = el.value !== undefined && typeof el.value === "string" ? el.value : "";
    const type = el.getAttribute("type") || "";
    const href = el.getAttribute("href") || "";
    const parts = [`[${ref}]`, `<${tag}`];
    if (type) parts.push(`type="${type}"`);
    if (role) parts.push(`role="${role}"`);
    parts[parts.length - 1] += ">";
    if (name) parts.push(`"${name.replace(/\s+/g, " ")}"`);
    if (value) parts.push(`value="${value.slice(0, 60)}"`);
    if (href && tag === "a") parts.push(`href="${href.slice(0, 80)}"`);
    return parts.join(" ");
  }

  // Reset registry on every snapshot so refs are stable for the snapshot returned.
  window.__nemo = window.__nemo || {};
  const registry = new Map();
  window.__nemo.refs = registry;

  // Strip stale data-nemo-ref attributes from previous snapshots.
  document.querySelectorAll("[data-nemo-ref]").forEach((el) => el.removeAttribute("data-nemo-ref"));

  const lines = [];
  const elements = [];
  const all = document.body ? document.body.querySelectorAll("*") : [];
  let counter = 0;

  for (const el of all) {
    if (!isInteractive(el)) continue;
    if (!isVisible(el)) continue;
    counter += 1;
    const ref = String(counter);
    registry.set(ref, el);
    el.setAttribute("data-nemo-ref", ref);
    const rect = el.getBoundingClientRect();
    elements.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      name: accessibleName(el),
      value: typeof el.value === "string" ? el.value : "",
      type: el.getAttribute("type") || "",
      href: el.getAttribute("href") || "",
      bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    });
    lines.push(describe(el, ref));
  }

  const bodyText = document.body ? (document.body.innerText || "").slice(0, 2000) : "";
  return {
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: window.scrollY },
    count: counter,
    elements,
    tree: lines.join("\n"),
    bodyText,
  };
}

export function performAction({ action, ref, text }) {
  function lookup(ref) {
    const fromRegistry = window.__nemo?.refs?.get(ref);
    if (fromRegistry && document.contains(fromRegistry)) return fromRegistry;
    return document.querySelector(`[data-nemo-ref="${CSS.escape(ref)}"]`);
  }

  const el = lookup(ref);
  if (!el) {
    return { ok: false, error: `No element with ref "${ref}". Take a fresh snapshot.` };
  }

  try {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  } catch {
    el.scrollIntoView();
  }

  const tag = el.tagName.toLowerCase();

  switch (action) {
    case "click": {
      // Some elements respond better to a real MouseEvent dispatch than to .click().
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
      return { ok: true, action: "click", ref };
    }

    case "type": {
      if (tag === "input" || tag === "textarea") {
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        el.focus();
        setter.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, action: "type", ref, text };
      }
      if (el.isContentEditable) {
        el.focus();
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);
        return { ok: true, action: "type", ref, text };
      }
      return { ok: false, error: "Element is not editable" };
    }

    case "press_enter": {
      el.focus();
      const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      return { ok: true, action: "press_enter", ref };
    }

    case "focus":
      el.focus();
      return { ok: true, action: "focus", ref };

    case "hover":
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      return { ok: true, action: "hover", ref };

    case "select": {
      if (tag !== "select") return { ok: false, error: "Element is not a <select>" };
      el.value = text;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, action: "select", ref, value: text };
    }

    case "submit": {
      const form = el.closest("form");
      if (!form) return { ok: false, error: "No enclosing <form>" };
      form.requestSubmit ? form.requestSubmit() : form.submit();
      return { ok: true, action: "submit", ref };
    }

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

// Find elements by CSS selector or text content. Unlike snapshotDom, this
// works on ANY element — decorative SVGs, structural divs, etc. — which is
// essential for layout/CSS work where the targets aren't "interactive".
// Reuses the same window.__nemo.refs registry so subsequent performAction
// / inspectElement calls work with the returned refs.
export function queryElements({ selector, text, limit }) {
  const cap = typeof limit === "number" && limit > 0 ? limit : 50;
  window.__nemo = window.__nemo || {};
  const registry = (window.__nemo.refs = window.__nemo.refs || new Map());

  let matches = [];
  if (selector) {
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch (err) {
      return { ok: false, error: `Bad selector: ${err.message}` };
    }
  } else if (typeof text === "string" && text.length) {
    const needle = text.toLowerCase();
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent) continue;
      if (!node.textContent.toLowerCase().includes(needle)) continue;
      const parent = node.parentElement;
      if (parent && !seen.has(parent)) {
        seen.add(parent);
        matches.push(parent);
        if (matches.length >= cap * 4) break; // cheap upper bound
      }
    }
  } else {
    return { ok: false, error: "Provide either selector or text" };
  }

  if (matches.length > cap) matches = matches.slice(0, cap);

  // Continue numbering from the highest existing ref so results are stable
  // alongside any prior snapshot_dom refs.
  let next = 0;
  for (const k of registry.keys()) {
    const n = parseInt(k, 10);
    if (Number.isFinite(n) && n > next) next = n;
  }

  const elements = matches.map((el) => {
    let ref = el.getAttribute("data-nemo-ref");
    if (!ref || !registry.has(ref) || registry.get(ref) !== el) {
      next += 1;
      ref = String(next);
      registry.set(ref, el);
      el.setAttribute("data-nemo-ref", ref);
    }
    const rect = el.getBoundingClientRect();
    return {
      ref,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList).slice(0, 5),
      bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      visible: rect.width > 0 && rect.height > 0,
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
    };
  });

  return { ok: true, count: elements.length, total: matches.length, elements };
}

// Return rich layout info for a single element: bbox, curated computed
// styles, parent chain, immediate children. Curated styles are the ~35 props
// that actually drive layout — full computed style is ~400 props and would
// drown the model.
export function inspectElement({ ref, selector }) {
  const LAYOUT_PROPS = [
    "display", "position", "top", "right", "bottom", "left",
    "width", "height", "min-width", "min-height", "max-width", "max-height",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "box-sizing", "overflow",
    "transform", "transform-origin",
    "z-index", "opacity", "visibility", "pointer-events",
    "flex", "flex-direction", "flex-wrap", "justify-content", "align-items",
    "align-self", "gap",
    "grid-template-columns", "grid-template-rows", "grid-area",
    "float", "clear",
    "color", "background-color",
    "border-top", "border-right", "border-bottom", "border-left", "border-radius",
    "font-family", "font-size", "font-weight", "line-height",
  ];

  function lookup() {
    if (ref) {
      return (
        window.__nemo?.refs?.get(ref) ||
        document.querySelector(`[data-nemo-ref="${CSS.escape(ref)}"]`)
      );
    }
    if (selector) {
      try { return document.querySelector(selector); } catch { return null; }
    }
    return null;
  }

  const el = lookup();
  if (!el) return { ok: false, error: "Element not found. Pass ref (from snapshot/query) or selector." };

  const cs = getComputedStyle(el);
  const styles = {};
  for (const prop of LAYOUT_PROPS) {
    const v = cs.getPropertyValue(prop).trim();
    if (v) styles[prop] = v;
  }

  const rect = el.getBoundingClientRect();

  // Parent chain — up to 6 ancestors, with the layout-relevant subset.
  const parents = [];
  let p = el.parentElement;
  while (p && parents.length < 6 && p !== document.documentElement) {
    const pRect = p.getBoundingClientRect();
    const pcs = getComputedStyle(p);
    parents.push({
      tag: p.tagName.toLowerCase(),
      id: p.id || null,
      classes: Array.from(p.classList).slice(0, 5),
      bbox: { x: pRect.x, y: pRect.y, w: pRect.width, h: pRect.height },
      display: pcs.display,
      position: pcs.position,
      overflow: pcs.overflow,
      transform: pcs.transform === "none" ? "" : pcs.transform,
    });
    p = p.parentElement;
  }

  const children = Array.from(el.children).slice(0, 30).map((c) => {
    const cRect = c.getBoundingClientRect();
    return {
      tag: c.tagName.toLowerCase(),
      id: c.id || null,
      classes: Array.from(c.classList).slice(0, 5),
      bbox: { x: cRect.x, y: cRect.y, w: cRect.width, h: cRect.height },
      text: (c.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
    };
  });

  // outerHTML truncated; for SVGs and complex elements, attribute-only
  // summary is more useful. Still include outerHTML for shorter elements.
  const outer = el.outerHTML || "";

  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: Array.from(el.classList),
    attributes: Array.from(el.attributes)
      .filter((a) => a.name !== "data-nemo-ref")
      .map((a) => ({ name: a.name, value: a.value.slice(0, 200) })),
    bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    documentBbox: {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      w: rect.width,
      h: rect.height,
    },
    styles,
    parents,
    childrenCount: el.children.length,
    children,
    outerHTML: outer.length > 2000 ? outer.slice(0, 2000) + "…" : outer,
  };
}

// Read just the bbox of a ref'd element in document coordinates so the
// background script can crop a screenshot to it.
export function getElementBbox({ ref }) {
  const el =
    window.__nemo?.refs?.get(ref) ||
    document.querySelector(`[data-nemo-ref="${CSS.escape(ref)}"]`);
  if (!el) return { ok: false, error: `No element with ref "${ref}"` };
  const rect = el.getBoundingClientRect();
  return {
    ok: true,
    bbox: {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      w: rect.width,
      h: rect.height,
    },
    visible: rect.width > 0 && rect.height > 0,
    tag: el.tagName.toLowerCase(),
  };
}

export function scrollPage({ direction, amount }) {
  const px = typeof amount === "number" ? amount : Math.round(window.innerHeight * 0.8);
  switch (direction) {
    case "down":
      window.scrollBy({ top: px, behavior: "instant" });
      break;
    case "up":
      window.scrollBy({ top: -px, behavior: "instant" });
      break;
    case "top":
      window.scrollTo({ top: 0, behavior: "instant" });
      break;
    case "bottom":
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      break;
    default:
      return { ok: false, error: `Unknown direction: ${direction}` };
  }
  return {
    ok: true,
    scrollY: window.scrollY,
    maxScrollY: document.documentElement.scrollHeight - window.innerHeight,
  };
}
