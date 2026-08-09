/* Water Data Collector - custom dark dashboard.
 *
 * Replaces the stock ESPHome web_server v3 app (hidden via dashboard.css)
 * with a small, self-contained, section-per-page style UI. Talks only to
 * ESPHome's existing, stable REST/SSE API (documented at
 * https://esphome.io/web-api/) - no external requests, no build step.
 *
 * Entity <-> section assignment and ordering is fully data-driven from the
 * `web_server: sorting_groups:` / per-entity `sorting_group_id` config in
 * the YAML - adding a new group (e.g. for the planned pressure sensors)
 * just works here without touching this file.
 */
(function () {
  "use strict";

  const ENTITY_CATEGORY_CONFIG = 1;
  const ENTITY_CATEGORY_DIAGNOSTIC = 2;
  const NUMBER_MODE_SLIDER = 2;
  const FALLBACK_GROUP = "Other";

  // Small hand-drawn icon set (24x24, stroke-based) - deliberately not an
  // icon font/CDN, so the page renders with zero network access.
  const ICONS = {
    water: '<path d="M12 3c3.5 4 6 7.2 6 10.2A6 6 0 0 1 6 13.2C6 10.2 8.5 7 12 3Z"/>',
    leaf: '<path d="M5 19c8 0 13-5 14-14-9 1-14 6-14 14Z"/><path d="M5 19c1-4 3.5-7 8-9"/>',
    wifi: '<path d="M3 8.5a15 15 0 0 1 18 0"/><path d="M6.3 12a10.5 10.5 0 0 1 11.4 0"/><path d="M9.5 15.5a6 6 0 0 1 5 0"/><circle cx="12" cy="18.5" r="1" fill="currentColor" stroke="none"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M4.6 7.5l1.9 1.1M17.5 15.4l1.9 1.1M3 12h2.2M18.8 12H21M4.6 16.5l1.9-1.1M17.5 8.6l1.9-1.1M7.5 4.6l1.1 1.9M15.4 17.5l1.1 1.9M7.5 19.4l1.1-1.9M15.4 6.5l1.1-1.9"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
  };
  const GROUP_ICON_BY_NAME = {
    "Main Meter": "water",
    "Garden Meter": "leaf",
    "Network": "wifi",
    "System": "cog",
  };

  function svgIcon(name) {
    const path = ICONS[name] || ICONS.dot;
    return `<svg viewBox="0 0 24 24">${path}</svg>`;
  }

  function el(tag, className, html) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // groupName -> { name, weight, navEl, panelEl, primaryEl, diagEl, settingsEl }
  const groups = new Map();
  // entity id ("domain-object_id") -> entity record
  const entities = new Map();
  let activeGroup = null;

  function ensureGroup(name, weight) {
    let g = groups.get(name);
    if (g) {
      if (weight !== undefined) g.weight = weight;
      return g;
    }
    const panelEl = el("div", "dc-panel");
    const primaryEl = el("div", "dc-tiles");
    const diagLabel = el("div", "dc-section-label", "Diagnostics");
    const diagEl = el("div", "dc-tiles dc-diagnostic");
    const settingsLabel = el("div", "dc-section-label", "Settings");
    const settingsEl = el("div", "dc-settings");
    panelEl.append(primaryEl, diagLabel, diagEl, settingsLabel, settingsEl);
    document.getElementById("dc-main").appendChild(panelEl);

    const navEl = el(
      "button",
      "dc-nav-item",
      `${svgIcon(GROUP_ICON_BY_NAME[name] || "dot")}<span>${name}</span>`
    );
    navEl.addEventListener("click", () => selectGroup(name));
    document.getElementById("dc-nav").appendChild(navEl);

    g = { name, weight: weight ?? 500, navEl, panelEl, primaryEl, diagEl, settingsEl };
    groups.set(name, g);
    reorderNav();
    // `sorting_group` SSE events may not arrive in weight order (iteration
    // order of the server's internal group map isn't guaranteed) - always
    // keep whichever group has the lowest weight selected, so we converge
    // on the intended first tab regardless of arrival order.
    if (!activeGroup || g.weight < groups.get(activeGroup).weight) selectGroup(name);
    return g;
  }

  function reorderNav() {
    const sorted = [...groups.values()].sort((a, b) => a.weight - b.weight);
    const nav = document.getElementById("dc-nav");
    for (const g of sorted) nav.appendChild(g.navEl);
  }

  function selectGroup(name) {
    activeGroup = name;
    for (const g of groups.values()) {
      const isActive = g.name === name;
      g.navEl.classList.toggle("active", isActive);
      g.panelEl.classList.toggle("active", isActive);
    }
    document.getElementById("dc-title").textContent = name;
  }

  function fmtValue(entity) {
    const v = entity.value;
    if (v === null || v === undefined || v === "") return "--";
    if (typeof v === "number") {
      if (Number.isNaN(v)) return "--";
      // `value` in the API is the raw float - accuracy_decimals is applied
      // server-side only to the separate, unit-suffixed `state` string, not
      // exposed on its own. Round to 3dp here purely for display (avoids
      // float noise like 12.340000000000001); every sensor in this project
      // is configured with accuracy_decimals <= 3, so this never shows more
      // precision than intended.
      return String(Math.round(v * 1000) / 1000);
    }
    return String(v);
  }

  function upsertTile(entity, container) {
    if (!entity.el) {
      entity.el = el(
        "div",
        "dc-tile",
        `<div class="value"><span class="val"></span><span class="unit"></span></div><div class="label"></div>`
      );
      container.appendChild(entity.el);
    }
    entity.el.querySelector(".val").textContent = fmtValue(entity);
    entity.el.querySelector(".unit").textContent = entity.uom || "";
    entity.el.querySelector(".label").textContent = entity.name;
  }

  function upsertNumberField(entity, container) {
    if (!entity.el) {
      entity.el = el(
        "div",
        "dc-field",
        `<div class="label"></div><div class="dc-field-row"></div><div class="dc-hint"></div>`
      );
      const row = entity.el.querySelector(".dc-field-row");
      const input = document.createElement("input");
      input.type = entity.mode === NUMBER_MODE_SLIDER ? "range" : "number";
      if (entity.min !== undefined) input.min = entity.min;
      if (entity.max !== undefined) input.max = entity.max;
      if (entity.step !== undefined) input.step = entity.step;
      row.appendChild(input);
      let readout = null;
      if (input.type === "range") {
        readout = el("span", null);
        readout.style.minWidth = "3.5em";
        readout.style.textAlign = "right";
        row.appendChild(readout);
      }
      input.addEventListener("change", () => {
        const value = input.value;
        fetch(`/number/${entity.objectId}/set?value=${encodeURIComponent(value)}`, { method: "POST" });
      });
      if (input.type === "range") {
        input.addEventListener("input", () => {
          readout.textContent = input.value + (entity.uom ? " " + entity.uom : "");
        });
      }
      entity.inputEl = input;
      entity.readoutEl = readout;
      container.appendChild(entity.el);
    }
    entity.el.querySelector(".label").textContent = entity.name;
    const hint = entity.el.querySelector(".dc-hint");
    hint.textContent =
      entity.min !== undefined && entity.max !== undefined
        ? `min ${entity.min}${entity.uom ? " " + entity.uom : ""} – max ${entity.max}${entity.uom ? " " + entity.uom : ""}`
        : "";
    // Don't clobber a value the user is actively editing.
    if (document.activeElement !== entity.inputEl) {
      entity.inputEl.value = entity.value ?? "";
      if (entity.readoutEl) entity.readoutEl.textContent = (entity.value ?? "") + (entity.uom ? " " + entity.uom : "");
    }
  }

  function upsertButtonField(entity, container) {
    if (!entity.el) {
      entity.el = el("div", "dc-field");
      const btn = el(
        "button",
        "dc-btn" + (/factory reset/i.test(entity.name) ? " dc-btn-danger" : ""),
        entity.name
      );
      btn.addEventListener("click", () => {
        btn.classList.add("dc-pressed");
        fetch(`/button/${entity.objectId}/press`, { method: "POST" }).finally(() => {
          setTimeout(() => btn.classList.remove("dc-pressed"), 400);
        });
      });
      entity.el.appendChild(btn);
      container.appendChild(entity.el);
    }
  }

  function render(entity) {
    const group = ensureGroup(entity.groupName ?? FALLBACK_GROUP, entity.groupWeight);
    if (entity.domain === "sensor" || entity.domain === "text_sensor") {
      upsertTile(entity, entity.category === ENTITY_CATEGORY_DIAGNOSTIC ? group.diagEl : group.primaryEl);
    } else if (entity.domain === "number") {
      upsertNumberField(entity, group.settingsEl);
    } else if (entity.domain === "button") {
      upsertButtonField(entity, group.settingsEl);
    }
  }

  function handleDetailAll(data) {
    let entity = entities.get(data.id);
    if (!entity) {
      entity = { id: data.id };
      entities.set(data.id, entity);
    }
    entity.domain = data.domain;
    // id looks like "{domain}-{object_id}" (see web_server.cpp set_json_id) -
    // domain is only present on detail_all payloads, which is exactly when
    // we need to derive object_id for the first time.
    entity.objectId = data.id.slice(data.domain.length + 1);
    entity.name = data.name || entity.objectId;
    entity.uom = data.uom;
    entity.category = data.entity_category || 0;
    entity.groupName = data.sorting_group;
    entity.groupWeight = data.sorting_weight;
    if (data.min_value !== undefined) entity.min = data.min_value;
    if (data.max_value !== undefined) entity.max = data.max_value;
    if (data.step !== undefined) entity.step = data.step;
    if (data.mode !== undefined) entity.mode = data.mode;
    entity.value = coerceValue(entity.domain, data.value);
    render(entity);
  }

  function handleState(data) {
    const entity = entities.get(data.id);
    if (!entity) return; // detail_all always arrives first on connect
    entity.value = coerceValue(entity.domain, data.value);
    render(entity);
  }

  // text_sensor values are genuinely strings (e.g. an IP address or the
  // firmware version) - parseFloat-ing "192.168.1.50" would silently
  // corrupt it into 192.168. Only sensor/number are numeric.
  function coerceValue(domain, raw) {
    if (domain === "sensor" || domain === "number") {
      return typeof raw === "number" ? raw : parseFloat(raw);
    }
    return raw;
  }

  function setConnected(connected) {
    const statusEl = document.getElementById("dc-status");
    statusEl.classList.toggle("connected", connected);
    statusEl.querySelector(".label").textContent = connected ? "Connected" : "Reconnecting…";
  }

  function buildShell() {
    const root = el("div", null);
    root.id = "dc-root";
    root.innerHTML = `
      <nav id="dc-nav"></nav>
      <main id="dc-main">
        <div id="dc-header">
          <h1 id="dc-title">Water Data Collector</h1>
          <div id="dc-status"><span class="dot"></span><span class="label">Connecting…</span></div>
        </div>
      </main>`;
    document.body.appendChild(root);
  }

  function connect() {
    const source = new EventSource("/events");
    source.addEventListener("sorting_group", (ev) => {
      const data = JSON.parse(ev.data);
      ensureGroup(data.name, data.sorting_weight);
    });
    source.addEventListener("state_detail_all", (ev) => handleDetailAll(JSON.parse(ev.data)));
    source.addEventListener("state", (ev) => handleState(JSON.parse(ev.data)));
    source.addEventListener("ping", () => setConnected(true));
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
  }

  function start() {
    buildShell();
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
