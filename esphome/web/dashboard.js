/* Water Data Collector - custom dark dashboard.
 *
 * Replaces the stock ESPHome web_server v3 app (hidden via dashboard.css)
 * with a small, self-contained UI built around what this device actually
 * does. Talks only to ESPHome's existing, stable REST/SSE API (documented
 * at https://esphome.io/web-api/) - no external requests, no build step.
 *
 * Four fixed pages, not one tab per sorting_group:
 *   - Home        - the meters' own readings (what the device is *for*)
 *   - Service     - meter calibration ("Reading" + "Update") and device
 *                   actions (Restart) - things you do occasionally
 *   - Diagnostics - everything else (network, system, per-meter raw
 *                   pulse data), as plain label/value rows
 *   - Log         - live debug output
 *
 * Which page an entity lands on is driven entirely by its `domain` and
 * `entity_category` from the YAML (see pageFor()) - adding a new sensor
 * (e.g. the planned pressure sensors) just works here without touching
 * this file, as long as it's tagged the same way (no entity_category for
 * a primary reading, `entity_category: diagnostic` for raw/debug data,
 * `entity_category: config` for calibration/actions).
 */
(function () {
  "use strict";

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
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2.8-2.8 2.8-2.8Z"/>',
    list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    terminal: '<path d="M4 5h16v14H4Z"/><path d="M7.5 9.5l3 2.5-3 2.5"/><path d="M13 15.5h4"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
  };
  const GROUP_ICON_BY_NAME = {
    "Main Meter": "water",
    "Garden Meter": "leaf",
    "Network": "wifi",
    "System": "cog",
  };
  const PAGES = [
    { id: "home", label: "Home", icon: "water" },
    { id: "service", label: "Service", icon: "wrench" },
    { id: "diagnostics", label: "Diagnostics", icon: "list" },
    { id: "log", label: "Log", icon: "terminal" },
  ];

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

  // entity id ("domain-object_id") -> entity record
  const entities = new Map();
  // sorting_group name -> group's own sorting_weight, from the dedicated
  // "sorting_group" SSE event (NOT the same as an entity's own
  // per-entity sorting_weight, which only orders entities *within* a
  // group - these two are easy to conflate).
  const groupWeights = new Map();
  let currentPage = "home";

  // --- Home page: one card per meter's sorting_group ------------------

  const homeGroups = new Map(); // groupName -> { weight, card, body }

  function ensureHomeGroup(name) {
    let g = homeGroups.get(name);
    if (g) return g;
    const card = el("div", "dc-meter-card");
    const header = el(
      "div",
      "dc-meter-card-header",
      `${svgIcon(GROUP_ICON_BY_NAME[name] || "dot")}<span>${name}</span>`
    );
    const body = el("div", "dc-meter-card-body");
    card.append(header, body);
    g = { weight: groupWeights.get(name) ?? 500, card, body };
    homeGroups.set(name, g);
    document.getElementById("dc-page-home").appendChild(card);
    reorderHomeGroups();
    return g;
  }

  function reorderHomeGroups() {
    const container = document.getElementById("dc-page-home");
    for (const g of [...homeGroups.values()].sort((a, b) => a.weight - b.weight)) {
      container.appendChild(g.card);
    }
  }

  function upsertHomeMetric(entity) {
    const group = ensureHomeGroup(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.el) {
      entity.el = el(
        "div",
        "dc-metric",
        `<div class="v"><span class="val"></span><span class="unit"></span></div><div class="l"></div>`
      );
      group.body.appendChild(entity.el);
    }
    entity.el.dataset.weight = entity.groupWeight ?? 500;
    entity.el.querySelector(".val").textContent = fmtValue(entity);
    entity.el.querySelector(".unit").textContent = entity.uom || "";
    entity.el.querySelector(".l").textContent = displayName(entity);
    // The lowest-weight metric in the card is the headline (big) number -
    // Total Consumption, by sorting_weight, see packages/water_meter.yaml.
    const rows = [...group.body.children].sort((a, b) => (+a.dataset.weight) - (+b.dataset.weight));
    rows.forEach((r, i) => {
      r.classList.toggle("dc-metric-headline", i === 0);
      group.body.appendChild(r);
    });
  }

  // --- Diagnostics page: grouped label/value rows ----------------------

  const diagGroups = new Map(); // groupName -> { weight, section, list }

  function ensureDiagGroup(name) {
    let g = diagGroups.get(name);
    if (g) return g;
    const section = el("div", "dc-diag-group");
    const label = el("div", "dc-section-label", name);
    const list = el("div", "dc-list");
    section.append(label, list);
    g = { weight: groupWeights.get(name) ?? 500, section, list };
    diagGroups.set(name, g);
    document.getElementById("dc-page-diagnostics").appendChild(section);
    reorderDiagGroups();
    return g;
  }

  function reorderDiagGroups() {
    const container = document.getElementById("dc-page-diagnostics");
    for (const g of [...diagGroups.values()].sort((a, b) => a.weight - b.weight)) {
      container.appendChild(g.section);
    }
  }

  function upsertDiagRow(entity) {
    const group = ensureDiagGroup(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.el) {
      entity.el = el("div", "dc-list-row", `<span class="k"></span><span class="v"></span>`);
      group.list.appendChild(entity.el);
    }
    entity.el.dataset.weight = entity.groupWeight ?? 500;
    entity.el.querySelector(".k").textContent = displayName(entity);
    entity.el.querySelector(".v").textContent = fmtValue(entity) + (entity.uom ? " " + entity.uom : "");
    for (const r of [...group.list.children].sort((a, b) => (+a.dataset.weight) - (+b.dataset.weight))) {
      group.list.appendChild(r);
    }
  }

  // --- Service page: calibration fields + device action buttons --------

  const serviceGroups = new Map(); // groupName -> { weight, section, fields }

  function ensureServiceGroup(name) {
    let g = serviceGroups.get(name);
    if (g) return g;
    const section = el("div", "dc-service-group");
    const label = el("div", "dc-section-label", name);
    const fields = el("div", "dc-fields");
    section.append(label, fields);
    g = { weight: groupWeights.get(name) ?? 500, section, fields };
    serviceGroups.set(name, g);
    document.getElementById("dc-page-service").appendChild(section);
    reorderServiceGroups();
    return g;
  }

  function reorderServiceGroups() {
    const container = document.getElementById("dc-page-service");
    for (const g of [...serviceGroups.values()].sort((a, b) => a.weight - b.weight)) {
      container.appendChild(g.section);
    }
  }

  // A number entity named "<Meter> Reading" (object_id ...maps to
  // "..._reading") and a button named "<Meter> Update" ("..._update")
  // are two ends of one calibration action - see the naming note next to
  // `sync_target`/`sync_apply` in packages/water_meter.yaml. Detect the
  // pairing purely from the id naming convention, so it keeps working
  // for any number of meters without hardcoding their names here.
  function comboBaseKey(id) {
    const m = /^number-(.+)_reading$/.exec(id) || /^button-(.+)_update$/.exec(id);
    return m ? m[1] : null;
  }

  function upsertServiceNumber(entity) {
    const group = ensureServiceGroup(entity.groupName ?? FALLBACK_GROUP);
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
        fetch(`${entity.namePath}/set?value=${encodeURIComponent(input.value)}`, { method: "POST" });
      });
      if (input.type === "range") {
        input.addEventListener("input", () => {
          readout.textContent = input.value + (entity.uom ? " " + entity.uom : "");
        });
      }
      entity.inputEl = input;
      entity.readoutEl = readout;
      group.fields.appendChild(entity.el);
    }
    entity.el.querySelector(".label").textContent = displayName(entity);
    const hint = entity.el.querySelector(".dc-hint");
    hint.textContent =
      entity.min !== undefined && entity.max !== undefined
        ? `min ${entity.min}${entity.uom ? " " + entity.uom : ""} – max ${entity.max}${entity.uom ? " " + entity.uom : ""}`
        : "";
    if (document.activeElement !== entity.inputEl) {
      entity.inputEl.value = entity.value ?? "";
      if (entity.readoutEl) entity.readoutEl.textContent = (entity.value ?? "") + (entity.uom ? " " + entity.uom : "");
    }
    const base = comboBaseKey(entity.id);
    if (base) {
      const sibling = entities.get(`button-${base}_update`);
      if (sibling) mountComboButton(sibling, entity.el.querySelector(".dc-field-row"));
    }
  }

  // Moves (or lazily creates) a paired Update button into a Reading
  // field's own row, relabelled "Update" regardless of its full entity
  // name - adjacency to the field already says what it updates, per CR
  // #7 ("nem egyértelmű" with the old "<Meter> Sync" label).
  function mountComboButton(buttonEntity, row) {
    if (!buttonEntity.btnEl) {
      buttonEntity.btnEl = el("button", "", "");
      buttonEntity.btnEl.addEventListener("click", () => pressButton(buttonEntity));
    }
    // Re-applied unconditionally, not just on creation: if the button's
    // own "state" event arrived before its Reading field's (the button
    // is rendered standalone as a fallback in that window, see
    // upsertServiceButton()), it already has a btnEl by the time we get
    // here, still carrying its standalone look - it needs to be relabelled
    // "Update"/restyled compact regardless of which path built it.
    buttonEntity.btnEl.className = "dc-btn dc-btn-compact";
    buttonEntity.btnEl.textContent = "Update";
    if (buttonEntity.btnEl.parentElement !== row) row.appendChild(buttonEntity.btnEl);
    if (buttonEntity.el) {
      buttonEntity.el.remove();
      buttonEntity.el = null;
    }
  }

  function pressButton(entity) {
    const btn = entity.btnEl;
    btn.classList.add("dc-pressed");
    fetch(`${entity.namePath}/press`, { method: "POST" }).finally(() => {
      setTimeout(() => btn.classList.remove("dc-pressed"), 400);
    });
  }

  function upsertServiceButton(entity) {
    const base = comboBaseKey(entity.id);
    if (base) {
      const numberEntity = entities.get(`number-${base}_reading`);
      if (numberEntity && numberEntity.el) {
        mountComboButton(entity, numberEntity.el.querySelector(".dc-field-row"));
        return;
      }
      // Reading field hasn't rendered yet - fall through to a standalone
      // button for now; upsertServiceNumber() will absorb it once it does.
    }
    const group = ensureServiceGroup(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.btnEl) {
      entity.el = el("div", "dc-field");
      entity.btnEl = el("button", "dc-btn", entity.name);
      entity.btnEl.addEventListener("click", () => pressButton(entity));
      entity.el.appendChild(entity.btnEl);
      group.fields.appendChild(entity.el);
    }
  }

  // --- Log page ----------------------------------------------------------

  const LOG_MAX_LINES = 400;
  // eslint-disable-next-line no-control-regex
  const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

  function appendLogLine(raw) {
    const pre = document.getElementById("dc-log");
    const stickToBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    const row = document.createElement("div");
    row.textContent = raw.replace(ANSI_ESCAPE_RE, "");
    pre.appendChild(row);
    while (pre.childElementCount > LOG_MAX_LINES) pre.removeChild(pre.firstChild);
    if (stickToBottom) pre.scrollTop = pre.scrollHeight;
  }

  // --- Shared helpers ------------------------------------------------

  // Entity names repeat their sorting_group's name as a prefix (e.g.
  // "Main Meter Reading" in the "Main Meter" group) so the raw HA/API
  // name stays self-explanatory - but on the dashboard, the surrounding
  // card/section header already says that, so drop the repeat here.
  function displayName(entity) {
    const g = entity.groupName;
    if (g && entity.name.startsWith(g + " ")) return entity.name.slice(g.length + 1);
    return entity.name;
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

  // Sole gate for the Factory Reset button: never rendered anywhere on
  // this UI (see CR #3 - a full page reachable by one tap is a bad place
  // for it), regardless of which page it would otherwise land on. Still
  // a perfectly normal entity for Home Assistant/the API.
  function isHiddenFromUi(entity) {
    return entity.domain === "button" && /factory reset/i.test(entity.name);
  }

  function pageFor(entity) {
    if (entity.category === ENTITY_CATEGORY_DIAGNOSTIC) return "diagnostics";
    if (entity.domain === "number" || entity.domain === "button") return "service";
    return "home";
  }

  function render(entity) {
    if (isHiddenFromUi(entity)) return;
    const page = pageFor(entity);
    if (page === "home") upsertHomeMetric(entity);
    else if (page === "diagnostics") upsertDiagRow(entity);
    else if (page === "service") {
      if (entity.domain === "number") upsertServiceNumber(entity);
      else if (entity.domain === "button") upsertServiceButton(entity);
    }
  }

  // `name_id` looks like "sensor/Wi-Fi Signal" - {domain}/{literal entity
  // name}. This is the only URL form still supported for REST calls: the
  // older /{domain}/{object_id} form (e.g. /sensor/wi-fi_signal) was
  // removed as of ESPHome 2026.7.0 (confirmed against a real device on
  // 2026.7.3 - those URLs now 404). Each segment needs its own
  // encodeURIComponent since the name can contain spaces/slashes-worth of
  // punctuation.
  function pathFromNameId(nameId) {
    return "/" + nameId.split("/").map(encodeURIComponent).join("/");
  }

  // Registers/refreshes everything about an entity. On this firmware
  // (ESPHome 2026.7.3) there's no separate one-time "state_detail_all"
  // dump - every entity's *first* `state` event already carries full
  // detail (domain, sorting_group, min/max, ...); only later updates for
  // an already-known entity are terse (just id/value/state). We treat
  // "has a `domain` field" as "this is a full payload", regardless of
  // which SSE event name it arrived under.
  function handleFullPayload(data) {
    let entity = entities.get(data.id);
    if (!entity) {
      entity = { id: data.id };
      entities.set(data.id, entity);
    }
    entity.domain = data.domain;
    entity.namePath = pathFromNameId(data.name_id);
    entity.name = data.name || data.id;
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

  function handleStateEvent(data) {
    if (data.domain !== undefined) {
      handleFullPayload(data);
      return;
    }
    const entity = entities.get(data.id);
    if (!entity) return; // terse update for an entity we haven't seen a full payload for yet - drop it, the next full one will catch us up
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

  // Updates a sorting_group's own weight (used to order Home cards /
  // Diagnostics sections / Service sections against each other) wherever
  // that group already has a container built - a group's "sorting_group"
  // SSE event can in principle arrive after some of its entities' first
  // "state" events, so this re-checks/reorders on every call rather than
  // assuming a one-time setup order.
  function setGroupWeight(name, weight) {
    groupWeights.set(name, weight);
    for (const [registry, reorder] of [
      [homeGroups, reorderHomeGroups],
      [diagGroups, reorderDiagGroups],
      [serviceGroups, reorderServiceGroups],
    ]) {
      const g = registry.get(name);
      if (g) {
        g.weight = weight;
        reorder();
      }
    }
  }

  function setConnected(connected) {
    const statusEl = document.getElementById("dc-status");
    statusEl.classList.toggle("connected", connected);
    statusEl.querySelector(".label").textContent = connected ? "Connected" : "Reconnecting…";
  }

  function selectPage(id) {
    currentPage = id;
    for (const p of PAGES) {
      const active = p.id === id;
      document.querySelector(`.dc-nav-item[data-page="${p.id}"]`).classList.toggle("active", active);
      document.getElementById(`dc-page-${p.id}`).classList.toggle("active", active);
    }
    document.getElementById("dc-title").textContent = PAGES.find((p) => p.id === id).label;
  }

  function buildShell() {
    const root = el("div", null);
    root.id = "dc-root";
    root.innerHTML = `
      <nav id="dc-nav">${PAGES.map(
        (p) => `<button class="dc-nav-item" data-page="${p.id}">${svgIcon(p.icon)}<span>${p.label}</span></button>`
      ).join("")}</nav>
      <main id="dc-main">
        <div id="dc-header">
          <h1 id="dc-title">Home</h1>
          <div id="dc-status"><span class="dot"></span><span class="label">Connecting…</span></div>
        </div>
        <section id="dc-page-home" class="dc-page"></section>
        <section id="dc-page-service" class="dc-page"></section>
        <section id="dc-page-diagnostics" class="dc-page"></section>
        <section id="dc-page-log" class="dc-page">
          <div id="dc-log-toolbar"><button id="dc-log-clear" class="dc-btn">Clear</button></div>
          <pre id="dc-log"></pre>
        </section>
      </main>`;
    document.body.appendChild(root);
    root.querySelectorAll(".dc-nav-item").forEach((btn) => btn.addEventListener("click", () => selectPage(btn.dataset.page)));
    document.getElementById("dc-log-clear").addEventListener("click", () => {
      document.getElementById("dc-log").innerHTML = "";
    });
    selectPage(currentPage);
  }

  // The dynamically-generated web_server v3 index.html (build_index_html()
  // in ESPHome's own source) doesn't set a <meta name="viewport"> at all -
  // only the older v1 HTML generator does. Without it, iOS Safari renders
  // the page at desktop width and our @media breakpoint in dashboard.css
  // never triggers (CR #1). Since this script owns the whole page anyway,
  // patch it in here instead of depending on ESPHome's generated <head>.
  // The apple-mobile-web-app-* tags additionally make "Add to Home
  // Screen" launch this as a standalone, browser-chrome-free app.
  function fixMobileMeta() {
    const metas = [
      ["name", "viewport", "width=device-width, initial-scale=1, viewport-fit=cover"],
      ["name", "apple-mobile-web-app-capable", "yes"],
      ["name", "apple-mobile-web-app-status-bar-style", "black-translucent"],
      ["name", "apple-mobile-web-app-title", "Water Collector"],
    ];
    for (const [attr, name, content] of metas) {
      if (document.head.querySelector(`meta[${attr}="${name}"]`)) continue;
      const m = document.createElement("meta");
      m.setAttribute(attr, name);
      m.setAttribute("content", content);
      document.head.appendChild(m);
    }
    document.title = "Water Data Collector";
  }

  function connect() {
    const source = new EventSource("/events");
    source.addEventListener("sorting_group", (ev) => {
      const data = JSON.parse(ev.data);
      setGroupWeight(data.name, data.sorting_weight);
    });
    // Both names are wired to the same handler: some ESPHome versions send
    // a one-time "state_detail_all" per entity before regular "state"
    // events, others (e.g. 2026.7.3, what this was actually tested
    // against) fold the full payload into the first "state" event
    // instead. handleStateEvent() figures out which kind it got.
    source.addEventListener("state_detail_all", (ev) => handleStateEvent(JSON.parse(ev.data)));
    source.addEventListener("state", (ev) => handleStateEvent(JSON.parse(ev.data)));
    // Raw logger output (web_server's default `log: true`) - plain text,
    // not JSON.
    source.addEventListener("log", (ev) => appendLogLine(ev.data));
    source.addEventListener("ping", () => setConnected(true));
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
  }

  function start() {
    fixMobileMeta();
    buildShell();
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
