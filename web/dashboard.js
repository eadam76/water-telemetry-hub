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

  // Short explanations, shown behind a tap-to-reveal "?" next to a
  // field/metric's label (CR #7). Keyed by displayName() - the label as
  // shown on screen, with the group name already stripped - so one entry
  // covers the entity in every meter's group without repeating it.
  // Nothing here for an entity that isn't in this map - the "?" just
  // doesn't render, rather than showing an empty hint.
  // Update/Restart deliberately have no entry here (CR #3 in the previous
  // round): the confirm dialog they already show on press explains the
  // consequence right when it matters - a permanent "?" next to them was
  // redundant clutter, not help.
  const HELP_TEXT = {
    "Total Consumption": "Cumulative water use, calculated from the pulse count and the last calibration - not a live meter photograph.",
    "Flow Rate": "Instantaneous flow, based on the time between the last two pulses. Drops to 0 automatically after Zero-Flow Timeout with no new pulses.",
    "Reading": "Enter the physical meter's current reading here, then press Update to apply it. Typing here alone changes nothing.",
    "Zero-Flow Timeout": "How long with no pulses before Flow Rate is shown as 0. Lower reacts faster; higher tolerates slow trickles without a false zero.",
    "Display Name": "Shown instead of the fixed name above, on the Dashboard page and here.",
    // Forget Wi-Fi deliberately has no entry here either, same reasoning as
    // Update/Restart (CR #3, previous round): its confirm dialog already
    // explains the consequence when it matters - a permanent "?" would
    // just be redundant clutter, and (found this round) also threw off
    // this button's row width relative to Restart's plain one.
  };

  // Buttons/fields whose action isn't easily undone get an explicit
  // confirmation before firing (CR #4, #6) - matched by displayName(),
  // so it applies uniformly across meters without hardcoding names.
  const CONFIRM_ON_PRESS = new Set(["Update", "Restart", "Forget Wi-Fi", "Delete"]);
  const CONFIRM_ON_CHANGE = new Set(["Zero-Flow Timeout"]);

  // Small hand-drawn icon set (24x24, stroke-based) - deliberately not an
  // icon font/CDN, so the page renders with zero network access.
  const ICONS = {
    water: '<path d="M12 3c3.5 4 6 7.2 6 10.2A6 6 0 0 1 6 13.2C6 10.2 8.5 7 12 3Z"/>',
    wifi: '<path d="M3 8.5a15 15 0 0 1 18 0"/><path d="M6.3 12a10.5 10.5 0 0 1 11.4 0"/><path d="M9.5 15.5a6 6 0 0 1 5 0"/><circle cx="12" cy="18.5" r="1" fill="currentColor" stroke="none"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M4.6 7.5l1.9 1.1M17.5 15.4l1.9 1.1M3 12h2.2M18.8 12H21M4.6 16.5l1.9-1.1M17.5 8.6l1.9-1.1M7.5 4.6l1.1 1.9M15.4 17.5l1.1 1.9M7.5 19.4l1.1-1.9M15.4 6.5l1.1-1.9"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2.8-2.8 2.8-2.8Z"/>',
    list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    terminal: '<path d="M4 5h16v14H4Z"/><path d="M7.5 9.5l3 2.5-3 2.5"/><path d="M13 15.5h4"/>',
    gauge: '<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-5"/><circle cx="12" cy="16" r="1" fill="currentColor" stroke="none"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    // Pressure table row actions (see upsertRegisteredPressureRow() below) -
    // pencil starts editing Name/Address, trash un-registers the slot,
    // check/close save or discard an in-progress edit.
    pencil: '<path d="M4 20l.7-3.5L16.2 5a1.5 1.5 0 0 1 2.1 0l0.7 0.7a1.5 1.5 0 0 1 0 2.1L7.5 19.3 4 20Z"/><path d="M14.5 7.5l2 2"/>',
    trash: '<path d="M5 7h14"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M7 7l1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    close: '<path d="M5 5l14 14M19 5L5 19"/>',
    chevronUp: '<path d="M6 15l6-6 6 6"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
  };
  // Keyed on the group's real (compile-time) name, never on its
  // renameable Display Name override (CR "generic naming") - so a rename
  // never leaves a group without an icon. Both meters share the same
  // icon: with generic naming there's no compile-time way to know which
  // one might be "the garden one", so there's nothing left to visually
  // distinguish them by beyond their (renameable) label.
  const GROUP_ICON_BY_NAME = {
    "Water Meter 1": "water",
    "Water Meter 2": "water",
    "Network": "wifi",
    "System": "cog",
  };
  // All 8 pressure sensor slots ("Pressure Sensor 1".."8" - see
  // packages/pressure_sensor.yaml) share one icon too, same reasoning as
  // the water meters above - matched by prefix instead of 8 literal map
  // entries, since which slot number is used isn't meaningful by itself.
  function groupIcon(name) {
    if (GROUP_ICON_BY_NAME[name]) return GROUP_ICON_BY_NAME[name];
    if (name.startsWith("Pressure Sensor")) return "gauge";
    return "dot";
  }
  // id stays "home" internally (localStorage key, #dc-page-home element id,
  // routing throughout this file) - only the displayed label changed to
  // "Dashboard" per the "Show on Dashboard" naming below, so the toggle's
  // own name and the page it controls visibility on now match each other.
  const PAGES = [
    { id: "home", label: "Dashboard", icon: "water" },
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
  // sorting_group name -> its "Show on Dashboard" switch's current state
  // (CR #9). Missing entry == not yet known/no such switch -> treated as
  // enabled, never as hidden, so groups without one (Network, System, ...)
  // are unaffected and a not-yet-arrived switch state doesn't flash-hide
  // anything.
  const groupEnabled = new Map();
  // sorting_group name -> its "Display Name" text's current value (CR
  // #8), shown on card/section headers instead of the fixed group name.
  // Missing/empty entry -> fall back to the real group name.
  const groupDisplayNames = new Map();
  let currentPage = "home";

  // A pressure slot's raw compile-time id (e.g. "Pressure Sensor 3") is
  // deliberately meaningless (see pressure_sensor.yaml's own file
  // header) and must never be shown anywhere in this UI - not even
  // transiently while its real Display Name hasn't arrived yet. On a
  // fresh connection/reconnect, entities arrive gradually, not
  // atomically (ESPHome dumps them in a fixed cross-domain order, not
  // registration order - see the note further up on the same
  // phenomenon affecting group labels generally) - a pressure slot's
  // Modbus Address (number domain) can easily be known before its
  // Display Name (text domain) is, which used to flash the raw id as
  // that card's header for a moment. Confirmed on real hardware,
  // 2026-08-13 - direct feedback was to show nothing at all rather than
  // the wrong thing. Every other group's raw name (Water Meter 1,
  // Network, ...) is fine to show as a fallback - only pressure slots
  // need this exception, isPressureGroup() is defined further down but
  // hoisted (function declaration), so it's callable from here.
  function groupLabel(name) {
    const custom = groupDisplayNames.get(name);
    if (custom) return custom;
    return isPressureGroup(name) ? "" : name;
  }

  // Re-applies a group's current display name to every page that has
  // already built a container for it - called both when the name itself
  // changes and (from ensure*Group()) when a container is created after
  // the name was already known, so arrival order never matters.
  function refreshGroupLabel(name) {
    const label = groupLabel(name);
    const home = homeGroups.get(name);
    if (home) home.card.querySelector(".dc-meter-card-header span").textContent = label;
    const svc = serviceGroups.get(name);
    if (svc) svc.section.querySelector(".dc-section-label").textContent = label;
    const diag = diagGroups.get(name);
    if (diag) diag.section.querySelector(".dc-section-label").textContent = label;
  }

  // ESPHome dumps every entity's full state right after connecting, but
  // in a fixed, cross-domain order baked into its own entities_iterator
  // (confirmed from source: sensor domain is always dumped before switch
  // and text) - so a meter's Home card/label is unavoidably built from
  // Flow Rate/Total Consumption *before* its Show on Dashboard/Display
  // Name catch up, a beat later. Without this, that shows up as a real,
  // visible flash: the raw group name and a visible-by-default card,
  // correcting themselves a moment later (CR #5, #6). applyGroupVisibility()/
  // applyGroupLabel() are the only things that ever touch dc-hidden/
  // the header text - both are no-ops until this fires
  // once, then settle the *final* state cleanly in one pass, and apply
  // immediately (no more waiting) for everything from then on, including
  // later reconnects.
  //
  // How long to wait isn't a fixed number: on a healthy network the whole
  // burst is over in well under a second, but on a congested one (a
  // laggy/roaming Wi-Fi - confirmed from real device logs with SCAN_
  // CONNECTING loops and multi-second ping RTTs) it can take much longer,
  // and a fixed short delay just moved *when* the flash happened, not
  // whether it did. So this debounces instead: every full-payload entity
  // (see scheduleSettle(), called from handleFullPayload()) pushes the
  // deadline out another SETTLE_QUIET_MS - it only actually settles once
  // entities stop arriving for that long, i.e. the burst is genuinely
  // over. SETTLE_MAX_MS is just a backstop in case that quiet moment
  // never comes, so the UI can't wait forever.
  const SETTLE_QUIET_MS = 800;
  const SETTLE_MAX_MS = 6000;
  let initialSettled = false;
  let settleQuietTimer = null;

  function scheduleSettle() {
    if (initialSettled) return;
    clearTimeout(settleQuietTimer);
    settleQuietTimer = setTimeout(settleInitialBurst, SETTLE_QUIET_MS);
  }

  function settleInitialBurst() {
    if (initialSettled) return;
    initialSettled = true;
    clearTimeout(settleQuietTimer);
    const names = new Set([...homeGroups.keys(), ...serviceGroups.keys(), ...diagGroups.keys()]);
    for (const name of names) {
      refreshGroupLabel(name);
      applyGroupVisibility(name);
    }
  }

  function applyGroupLabel(name) {
    if (!initialSettled) return;
    refreshGroupLabel(name);
  }

  // Generic group-visibility hook - currently dormant (nothing calls
  // groupEnabled.set(), so groupEnabled.get(name) is always undefined,
  // and this always leaves dc-hidden off) since the one thing that used
  // to drive it, water meters' old "Show on Dashboard" switch, was
  // unified into the Registered-gated create/remove model instead
  // (2026-08-13, see renderPulseMeterEntity()'s own comment) - same
  // reasoning pressure sensor slots already used, see
  // syncPressureHomeCard()'s own comment. Left in place as generic
  // infrastructure rather than removed outright, in case some future
  // group ever wants a plain show/hide toggle without the stronger
  // create/remove semantics.
  function applyGroupVisibility(name) {
    if (!initialSettled) return;
    const enabled = groupEnabled.get(name) !== false;
    const home = homeGroups.get(name);
    if (home) home.card.classList.toggle("dc-hidden", !enabled);
  }

  // --- Home page: one card per meter's sorting_group ------------------

  const homeGroups = new Map(); // groupName -> { weight, card, body }

  function ensureHomeGroup(name) {
    let g = homeGroups.get(name);
    if (g) return g;
    const card = el("div", "dc-meter-card");
    const header = el(
      "div",
      "dc-meter-card-header",
      `${svgIcon(groupIcon(name))}<span>${groupLabel(name)}</span>`
    );
    const body = el("div", "dc-meter-card-body");
    card.append(header, body);
    g = { weight: groupWeights.get(name) ?? 500, card, body };
    homeGroups.set(name, g);
    document.getElementById("dc-page-home").appendChild(card);
    reorderHomeGroups();
    applyGroupVisibility(name); // no-op until the initial SSE burst settles - see settleInitialBurst()
    return g;
  }

  function reorderHomeGroups() {
    const container = document.getElementById("dc-page-home");
    for (const g of [...homeGroups.values()].sort((a, b) => a.weight - b.weight)) {
      container.appendChild(g.card);
    }
  }

  // `forceUnavailable` (used by syncPressureHomeCard() for a collision-
  // flagged slot) shows "--" regardless of entity.value - a *clean,
  // CRC-valid* read during an active Modbus address collision still
  // isn't trustworthy, since there's no way to tell which of the two
  // colliding devices actually answered that particular poll; showing
  // whatever number happened to come back (real hardware confirmed this
  // visibly flickering between "-- bar" and an actual reading,
  // 2026-08-13) would silently attribute it to the wrong sensor just as
  // often as the right one.
  function upsertHomeMetric(entity, forceUnavailable) {
    const group = ensureHomeGroup(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.el) {
      entity.el = el(
        "div",
        "dc-metric",
        `<div class="v"><span class="val"></span><span class="unit"></span></div><div class="l"><span class="label-text"></span></div>`
      );
      group.body.appendChild(entity.el);
    }
    entity.el.dataset.weight = entity.groupWeight ?? 500;
    entity.el.querySelector(".val").textContent = forceUnavailable ? "--" : fmtValue(entity);
    entity.el.querySelector(".unit").textContent = forceUnavailable ? "" : entity.uom || "";
    const label = displayName(entity);
    entity.el.querySelector(".label-text").textContent = label;
    attachHelp(entity.el.querySelector(".l"), HELP_TEXT[label]);
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
    const label = el("div", "dc-section-label", groupLabel(name));
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
    const label = el("div", "dc-section-label", groupLabel(name));
    const fields = el("div", "dc-fields");
    section.append(label, fields);
    g = { weight: groupWeights.get(name) ?? 500, section, fields };
    serviceGroups.set(name, g);
    document.getElementById("dc-page-service").appendChild(section);
    reorderServiceGroups();
    applyGroupVisibility(name); // no-op until the initial SSE burst settles - see settleInitialBurst()
    return g;
  }

  function reorderServiceGroups() {
    const container = document.getElementById("dc-page-service");
    for (const g of [...serviceGroups.values()].sort((a, b) => a.weight - b.weight)) {
      container.appendChild(g.section);
    }
  }

  // Unlike Home/Diagnostics (which have always done this), Service fields
  // used to just render in SSE arrival order - not sorting_weight order -
  // since nothing ever re-sorted group.fields's children. Harmless while
  // every field's weight happened to already match arrival order, but
  // moving "Show on Dashboard" to the end (see packages/water_meter.yaml)
  // exposed it: arrival order (a fixed, per-domain sequence baked into
  // ESPHome's own entities_iterator - see the note further up) doesn't
  // actually track sorting_weight across domains. Same pattern as
  // reorderHomeGroups()/reorderDiagGroups() - read the weight already
  // stashed on each field by its own upsert*() call, sort, re-append.
  function reorderServiceFields(group) {
    for (const r of [...group.fields.children].sort((a, b) => (+a.dataset.weight) - (+b.dataset.weight))) {
      group.fields.appendChild(r);
    }
  }

  // --- Pressure sensor table (Service + Home pages) ---------------------
  //
  // v3 (2026-08-13, see REQUIREMENTS.md "Architekturális megfontolás v3"):
  // a JOIN, computed here in the browser, between two independent things -
  // neither of which is itself "the" answer to "what sensors exist":
  //   - the 8 fixed slots (packages/pressure_sensor.yaml), each persisting
  //     only a Modbus Address + Display Name - a slot counts as
  //     *registered* purely by Address != 0, no separate commissioned flag
  //     (see that file's own header for why one fewer persisted concept).
  //     Each registered slot also has its own live "Online" binary_sensor,
  //     fed by that slot's own continuous pressure poll - NOT by the scan
  //     below; a registered slot is watched continuously, not just when
  //     someone happens to press Scan Bus.
  //   - the latest bus-scan result (water-collector.yaml's "Scan Bus"
  //     button -> "Scan Results" text_sensor, rs485_modbus::scan_bus()) -
  //     a live, never-persisted CSV of addresses that answered just now,
  //     used only to find addresses no slot has registered yet.
  // Registered + Online -> "OK". Registered + NOT Online -> "Lost" (the
  // real diagnostic signal - see REQUIREMENTS.md's discussion of why this
  // can't instead be a reliable live electrical collision check). Scanned
  // but not registered -> its own row with a per-row Add button.
  // Slot number/order is never shown - see pressure_sensor.yaml's header -
  // rows are sorted purely by address.
  //
  // This whole section (and the umbrella "Pressure Sensors" group's own
  // entities) is intercepted in render() before it ever reaches
  // ensureServiceGroup()/ensureHomeGroup() - see isPressureGroup() below.
  //
  // Every pressure entity always exists/is always sent to every client
  // from the first connection onward, same as every other entity in this
  // file - ESPHome has no supported way to hide one at runtime (confirmed
  // from the installed package's own esphome/core/entity_base.h,
  // `set_internal()` is deprecated/undefined behavior - see git history
  // for that finding). Only whether a *row* gets built from that data is
  // conditional, which is what avoids a create-then-hide flash.

  const PRESSURE_SLOT_RE = /^Pressure Sensor \d+$/;
  const PRESSURE_ADD_GROUP = "Pressure Sensors";
  const PRESSURE_MAX_SLOTS = 8;

  function isPressureGroup(name) {
    return name === PRESSURE_ADD_GROUP || PRESSURE_SLOT_RE.test(name);
  }

  function pressureSlotEntity(groupName, label) {
    for (const e of entities.values()) {
      if (e.groupName === groupName && displayName(e) === label) return e;
    }
    return null;
  }

  // Every registered slot (Modbus Address != 0), with its own live
  // Online status (from that slot's continuous pressure poll,
  // packages/pressure_sensor.yaml - NOT from the shared bus-scan result,
  // that's a separate, on-demand thing used only to find still-
  // unregistered addresses, see latestScanAddresses() below). Address is
  // coerced to a whole number since the number entity's `value` is a
  // plain float over the API. `online` is `undefined` until this slot's
  // first poll completes (a few seconds after boot/registration) -
  // treated the same as "not confirmed online yet" by callers (see
  // upsertRegisteredPressureRow()'s own "Checking…" state).
  //
  // Checking `onlineEntity.value !== undefined`, not just truthiness of
  // `onlineEntity` itself, is load-bearing: the entity object exists in
  // `entities` from the moment its *declaration* is known (effectively
  // from connection), well before its binary_sensor has ever actually
  // published a state - which for a just-registered slot doesn't happen
  // until its first poll completes. Without this distinction,
  // `onlineEntity.value === true` silently evaluated to `false` for that
  // whole window (comparing `undefined === true`), not `undefined` as
  // the comment above already claimed - confirmed on real hardware,
  // 2026-08-13: a freshly-added, perfectly healthy sensor visibly
  // flashed "Lost" for a moment before its first poll ever ran.
  function registeredPressureSlots() {
    const slots = [];
    for (const e of entities.values()) {
      if (e.groupName && PRESSURE_SLOT_RE.test(e.groupName) && e.domain === "number" && displayName(e) === "Modbus Address") {
        const address = Math.round(e.value || 0);
        if (address > 0) {
          const onlineEntity = pressureSlotEntity(e.groupName, "Online");
          const orderEntity = pressureSlotEntity(e.groupName, "Sort Order");
          slots.push({
            groupName: e.groupName,
            address,
            online: onlineEntity && onlineEntity.value !== undefined ? onlineEntity.value === true : undefined,
            order: orderEntity ? Math.round(orderEntity.value || 0) : 0,
          });
        }
      }
    }
    return slots;
  }

  // Registered slots in *display* order - each slot's own Sort Order
  // (packages/pressure_sensor.yaml's "${friendly_name} Sort Order", the
  // Up/Down buttons below) when it's been customized (non-zero); a slot
  // still at its default 0 falls back to plain address order and sorts
  // after every customized one. Deliberately unrelated to Modbus address
  // or which physical slot a sensor happens to occupy - this exists
  // purely so the dashboard can be made to match the physical pipe
  // layout instead, per direct feedback, 2026-08-13.
  function orderedRegisteredSlots() {
    return [...registeredPressureSlots()].sort((a, b) => {
      if (a.order && b.order) return a.order - b.order;
      if (a.order) return -1;
      if (b.order) return 1;
      return a.address - b.address;
    });
  }

  // Moves `groupName` one step up/down (direction -1/+1) in the current
  // display order and persists the result by rewriting *every* registered
  // slot's own Sort Order to match the new sequence (1, 2, 3, ...) - not
  // just the two rows that swapped. Simpler and self-healing than a
  // narrower two-row-only update: it can never leave a stale or
  // duplicate rank behind regardless of what state Sort Order happened to
  // be in before (including every slot still at the default 0), at the
  // cost of up to 8 extra requests for a rare, deliberate user action.
  function movePressureRow(groupName, direction) {
    const ordered = orderedRegisteredSlots();
    const idx = ordered.findIndex((s) => s.groupName === groupName);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= ordered.length) return;
    const names = ordered.map((s) => s.groupName);
    [names[idx], names[swapIdx]] = [names[swapIdx], names[idx]];
    names.forEach((gName, i) => {
      const e = pressureSlotEntity(gName, "Sort Order");
      if (e) fetch(`${e.namePath}/set?value=${i + 1}`, { method: "POST" });
    });
  }

  // The last bus-scan result, parsed from its CSV text_sensor - e.g.
  // "1,4,9" -> [1, 4, 9]. Empty/garbage entries are silently dropped
  // rather than surfaced as an error - this is a diagnostic aid, not a
  // form to validate.
  function latestScanAddresses() {
    const e = pressureSlotEntity(PRESSURE_ADD_GROUP, "Scan Results");
    if (!e || typeof e.value !== "string" || !e.value.trim()) return [];
    return e.value
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 247);
  }

  // Addresses where the last scan got a reply that failed its own CRC
  // check - see include/rs485_modbus.h's scan_bus()/probe() for why this
  // is a real (if not airtight) signal that two+ devices are answering
  // to the same address, distinct from both a clean find and plain
  // silence. An address is never in both this and latestScanAddresses()
  // at once - each address gets exactly one outcome per scan.
  function latestCollisionAddresses() {
    const e = pressureSlotEntity(PRESSURE_ADD_GROUP, "Scan Collisions");
    if (!e || typeof e.value !== "string" || !e.value.trim()) return [];
    return e.value
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 247);
  }

  // Cross-slot duplicate check, purely against sensors already registered
  // in *this* list - not a real electrical bus collision check (that
  // needs actually talking Modbus over the real hardware, not available
  // yet - see REQUIREMENTS.md). Returns the Display Name of whichever
  // other registered slot already holds `address`, or null.
  function findPressureAddressOwner(address, excludeGroup) {
    for (const slot of registeredPressureSlots()) {
      if (slot.groupName === excludeGroup || slot.address !== address) continue;
      const nameEntity = pressureSlotEntity(slot.groupName, "Display Name");
      return (nameEntity && nameEntity.value) || slot.groupName;
    }
    return null;
  }

  let pressureTableBody = null;
  let pressureToolbarEl = null;

  // Registers the umbrella "Pressure Sensors" group as a normal
  // serviceGroups entry (reusing reorderServiceGroups()'s existing
  // weight-based interleaving with the meter/system sections, for free)
  // but with a bespoke body - a small toolbar (just the Scan Bus button)
  // above a table, instead of the generic .dc-fields list - built once,
  // on first use.
  function ensurePressureTable() {
    let g = serviceGroups.get(PRESSURE_ADD_GROUP);
    if (g) return pressureTableBody;
    const section = el("div", "dc-service-group dc-pressure-group");
    const label = el("div", "dc-section-label", "Pressure Sensors");
    const toolbar = el("div", "dc-pressure-toolbar");
    const table = el(
      "table",
      "dc-pressure-table",
      `<thead><tr><th>Name</th><th>Address</th><th>Status</th><th></th><th></th></tr></thead><tbody></tbody>`
    );
    // A future extra column (e.g. device class - QDW90A vs. a flow meter
    // once more Modbus device types land) has to go somewhere; scrolling
    // the table itself horizontally, on whichever screen is too narrow
    // for it, beats squeezing every column down or clipping content
    // outright (#dc-main forces overflow-x: hidden page-wide - see its
    // own comment).
    const tableScroll = el("div", "dc-pressure-table-scroll");
    tableScroll.appendChild(table);
    section.append(label, toolbar, tableScroll);
    g = { weight: groupWeights.get(PRESSURE_ADD_GROUP) ?? 500, section };
    serviceGroups.set(PRESSURE_ADD_GROUP, g);
    document.getElementById("dc-page-service").appendChild(section);
    reorderServiceGroups();
    pressureTableBody = table.querySelector("tbody");
    pressureToolbarEl = toolbar;
    return pressureTableBody;
  }

  // The real "Scan Bus" button (water-collector.yaml -
  // rs485_modbus::scan_bus()) - a plain button mounted into the toolbar
  // above the table, same wiring as a generic Service field but without
  // pulling in ensureServiceGroup()'s .dc-fields layout. Deliberately
  // NOT routed through the shared pressButton() (its brief ".dc-pressed"
  // flash doesn't fit a ~6s operation) - disabled + relabeled "Scanning…"
  // instead, driven by its own live "Scan In Progress" binary_sensor
  // (see syncScanButtonBusyState() below), NOT the fetch() promise's own
  // lifetime - tried that first, but confirmed on real hardware,
  // 2026-08-13, that ESPHome's web_server doesn't hold the HTTP response
  // open for a button's on_press: to actually finish, so the fetch
  // resolved almost immediately, well before the real ~6s scan was done.
  // Feedback here matters beyond cosmetics: with none at all, it wasn't
  // obvious a scan was running, which invited exactly the kind of
  // repeated re-clicking that (combined with the try_register bug fixed
  // the same day) produced duplicate registrations.
  function mountPressureToolbarButton(entity) {
    if (!entity.btnEl) {
      entity.idleLabel = displayName(entity);
      // The button's own label never changes (previously swapped to
      // "Scanning…", which - being longer than "Scan Bus" - visibly grew
      // the button itself mid-scan, confirmed to look wrong on real
      // hardware, 2026-08-13). "Scanning…" + the spinner instead live in
      // a separate status element next to the button, so the button's
      // own size is fixed regardless of state.
      entity.btnEl = el("button", "dc-btn dc-btn-compact", entity.idleLabel);
      entity.btnEl.addEventListener("click", () => {
        if (entity.btnEl.disabled) return;
        fetch(`${entity.namePath}/press`, { method: "POST" });
      });
      entity.statusEl = el("span", "dc-pressure-scan-status", `<span class="dc-spinner"></span><span>Scanning…</span>`);
      entity.statusEl.hidden = true;
      pressureToolbarEl.append(entity.btnEl, entity.statusEl);
    }
  }

  // Drives the Scan Bus button's busy state from modbus_scan_in_progress
  // (see mountPressureToolbarButton()'s own comment for why this - not
  // the button entity's own fetch() - is the source of truth). A ~6s
  // scan with only a disabled button as feedback still read as "did this
  // actually do anything?" at a glance - the adjacent spinner+label is a
  // second, more immediately legible "something is happening" signal.
  function syncScanButtonBusyState(inProgress) {
    const scanEntity = pressureSlotEntity(PRESSURE_ADD_GROUP, "Scan Bus");
    if (!scanEntity || !scanEntity.btnEl) return;
    scanEntity.btnEl.disabled = inProgress;
    scanEntity.statusEl.hidden = !inProgress;
  }

  const pressureTableRows = new Map(); // "reg:"+groupName or "new:"+address -> <tr>
  const pressureNewRowDrafts = new Map(); // address -> in-progress typed name, kept across re-renders until Add/rescan

  // A registered slot's row. Status is normally this slot's own live
  // Online value (OK/Lost), but a collision seen at this exact address in
  // the last scan overrides that - a garbled reply is a much more
  // specific, actionable signal ("something else is answering to your
  // address too") than a plain Lost, so it takes priority over whatever
  // the last poll happened to see.
  //
  // `online` is a tri-state: true/false once this slot's own poll has
  // actually reported something, or `undefined` for the brief window
  // between a fresh Add and that first poll completing (up to this
  // slot's own ~600-670ms interval) - shown as "Checking…", not "Lost".
  // Rendering it as Lost was real hardware feedback, 2026-08-13: a
  // just-added, perfectly healthy sensor still visibly flashed Lost for
  // a moment, since a fresh row starts with no Online reading yet at all
  // (indistinguishable, before this, from a genuinely unreachable one) -
  // Lost should mean "this slot was confirmed and then dropped off", not
  // "haven't heard from it yet".
  //
  // Name/Address are read-only until the row's own pencil button is
  // pressed, then editable with an explicit Save/Cancel - previously they
  // wrote on every blur (a plain HTML `change` event), which made it
  // dangerously easy to fire a real reprogram (Address really does
  // rewrite the physical sensor - see pressure_sensor.yaml's Modbus
  // Address set_action) just by tabbing through the row or clicking
  // elsewhere mid-edit. Confirmed too easy to trigger by accident on real
  // use, 2026-08-13.
  function upsertRegisteredPressureRow(tbody, groupName, online, hasCollision, isFirst, isLast) {
    const key = "reg:" + groupName;
    const nameEntity = pressureSlotEntity(groupName, "Display Name");
    const addrEntity = pressureSlotEntity(groupName, "Modbus Address");
    const delEntity = pressureSlotEntity(groupName, "Delete");
    let row = pressureTableRows.get(key);
    if (!row) {
      row = el(
        "tr",
        "dc-pressure-row-registered",
        `<td class="dc-pressure-name"></td><td class="dc-pressure-addr"></td><td class="dc-pressure-status"></td><td class="dc-pressure-action"></td><td class="dc-pressure-order"></td>`
      );
      pressureTableRows.set(key, row);
      tbody.appendChild(row);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 32;
      nameInput.disabled = true;
      row.querySelector(".dc-pressure-name").appendChild(nameInput);
      row._nameInput = nameInput;

      const addrInput = document.createElement("input");
      addrInput.type = "number";
      addrInput.min = 1;
      addrInput.max = 247;
      addrInput.step = 1;
      addrInput.disabled = true;
      row.querySelector(".dc-pressure-addr").appendChild(addrInput);
      row._addrInput = addrInput;

      const status = el("span", "dc-pressure-badge");
      row.querySelector(".dc-pressure-status").appendChild(status);
      row._statusEl = status;

      const actionCell = row.querySelector(".dc-pressure-action");

      const editBtn = el("button", "dc-pressure-icon-btn dc-pressure-edit-btn", svgIcon("pencil"));
      editBtn.type = "button";
      editBtn.title = "Edit name/address";
      actionCell.appendChild(editBtn);
      row._editBtn = editBtn;

      // Trash, not the old bare "✕" - reads more clearly as "delete this
      // registration" at a glance (per direct feedback, 2026-08-13).
      const delBtn = el("button", "dc-pressure-icon-btn dc-pressure-del-btn", svgIcon("trash"));
      delBtn.type = "button";
      delBtn.title = "Delete";
      actionCell.appendChild(delBtn);
      row._delBtn = delBtn;

      const saveBtn = el("button", "dc-pressure-icon-btn dc-pressure-save-btn", svgIcon("check"));
      saveBtn.type = "button";
      saveBtn.title = "Save";
      actionCell.appendChild(saveBtn);
      row._saveBtn = saveBtn;

      const cancelBtn = el("button", "dc-pressure-icon-btn dc-pressure-cancel-btn", svgIcon("close"));
      cancelBtn.type = "button";
      cancelBtn.title = "Cancel";
      actionCell.appendChild(cancelBtn);
      row._cancelBtn = cancelBtn;

      // Up/Down - reorders this row relative to the other registered
      // rows (movePressureRow() above), independent of the edit lock
      // above (no need to press the pencil first). Physically the slot
      // doesn't move at all, only the Sort Order metadata each slot
      // carries - see that number entity's own comment in
      // pressure_sensor.yaml. Disabled at whichever end of the list a row
      // already sits at (isFirst/isLast below), rather than just being a
      // no-op click - visibly not just cosmetically first/last.
      const orderGroup = el("div", "dc-pressure-order-group");
      row.querySelector(".dc-pressure-order").appendChild(orderGroup);
      const upBtn = el("button", "dc-pressure-icon-btn dc-pressure-order-btn", svgIcon("chevronUp"));
      upBtn.type = "button";
      upBtn.title = "Move up";
      upBtn.addEventListener("click", () => movePressureRow(groupName, -1));
      const downBtn = el("button", "dc-pressure-icon-btn dc-pressure-order-btn", svgIcon("chevronDown"));
      downBtn.type = "button";
      downBtn.title = "Move down";
      downBtn.addEventListener("click", () => movePressureRow(groupName, 1));
      orderGroup.append(upBtn, downBtn);
      row._upBtn = upBtn;
      row._downBtn = downBtn;

      const enterEdit = () => {
        row._editOrigName = nameInput.value;
        row._editOrigAddr = addrInput.value;
        nameInput.disabled = false;
        addrInput.disabled = false;
        row.classList.add("dc-pressure-row-editing");
        row._editing = true;
        nameInput.focus();
        nameInput.select();
      };
      const exitEdit = () => {
        nameInput.disabled = true;
        addrInput.disabled = true;
        row.classList.remove("dc-pressure-row-editing");
        row._editing = false;
      };
      editBtn.addEventListener("click", enterEdit);
      cancelBtn.addEventListener("click", () => {
        nameInput.value = row._editOrigName;
        addrInput.value = row._editOrigAddr;
        exitEdit();
      });
      // Enter = Save, Escape = Cancel, mirroring the pencil's own pair of
      // icon buttons rather than requiring a reach for the mouse.
      // Deliberately attached to the inputs themselves, not the row -
      // a disabled input never receives keydown from user typing in the
      // first place, so this is naturally a no-op outside edit mode
      // without needing its own row._editing guard.
      const handleEditKeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveBtn.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelBtn.click();
        }
      };
      nameInput.addEventListener("keydown", handleEditKeydown);
      addrInput.addEventListener("keydown", handleEditKeydown);
      saveBtn.addEventListener("click", () => {
        // A blank Display Name doesn't just look empty - groupLabel()'s
        // own fallback (dashboard.js's shared home/section-header logic)
        // falls straight through to the group's raw compile-time id
        // (e.g. "Pressure Sensor 3") the moment the stored name is
        // empty, exactly the internal, deliberately-meaningless string
        // this whole file goes out of its way to never show elsewhere.
        // The Add flow already required a name before it would even
        // fire (upsertNewPressureRow()); confirmed on real hardware,
        // 2026-08-13, that editing an existing row back to blank was
        // still wide open to the same problem - required here too.
        if (!nameInput.value.trim()) {
          alert("Name can't be empty.");
          return; // stay in edit mode so it can be fixed
        }
        const parsed = parseInt(addrInput.value, 10);
        if (Number.isNaN(parsed) || parsed < 1 || parsed > 247) {
          alert("Address must be a number between 1 and 247.");
          return; // stay in edit mode so the value can be fixed
        }
        const dupe = findPressureAddressOwner(parsed, groupName);
        if (
          dupe &&
          !confirm(
            `Address ${parsed} is already registered as "${dupe}". This only checks sensors already registered here, not the physical bus - set it anyway?`
          )
        ) {
          return; // stay in edit mode
        }
        const ne = pressureSlotEntity(groupName, "Display Name");
        const ae = pressureSlotEntity(groupName, "Modbus Address");
        saveBtn.disabled = true;
        cancelBtn.disabled = true;
        const requests = [];
        if (ne) requests.push(fetch(`${ne.namePath}/set?value=${encodeURIComponent(nameInput.value)}`, { method: "POST" }));
        if (ae) requests.push(fetch(`${ae.namePath}/set?value=${encodeURIComponent(parsed)}`, { method: "POST" }));
        Promise.all(requests).finally(() => {
          saveBtn.disabled = false;
          cancelBtn.disabled = false;
          exitEdit();
        });
      });
    }
    // pressButton() reads entity.btnEl (for the press animation) - unlike
    // every other button in this file, this one is never routed through
    // upsertServiceButton() (pressure entities are all intercepted before
    // they'd get there), so nothing else ever sets it. Without this the
    // click handler threw (`btnEl` undefined) before the fetch() ever
    // fired - the X looked completely dead, confirmed on real hardware.
    if (delEntity) delEntity.btnEl = row._delBtn;
    row._delBtn.onclick = () => {
      if (delEntity) pressButton(delEntity);
    };
    // Never overwrites an in-progress edit's own local (unsaved) values -
    // same reasoning as every other field in this file's activeElement
    // guards, extended to the whole row (not just whichever input has
    // focus right now) since Save/Cancel can be clicked while focus has
    // already moved off the input being edited.
    if (!row._editing) {
      row._nameInput.value = (nameEntity && nameEntity.value) || "";
      if (addrEntity) row._addrInput.value = addrEntity.value ?? "";
    }
    row._statusEl.textContent = hasCollision ? "Collision" : online === undefined ? "Checking…" : online ? "OK" : "Lost";
    row._statusEl.classList.toggle("dc-pressure-badge-ok", online === true && !hasCollision);
    row._statusEl.classList.toggle("dc-pressure-badge-lost", online === false && !hasCollision);
    row._statusEl.classList.toggle("dc-pressure-badge-collision", hasCollision);
    row._statusEl.classList.toggle("dc-pressure-badge-pending", online === undefined && !hasCollision);
    row._upBtn.disabled = !!isFirst;
    row._downBtn.disabled = !!isLast;
    // Mirrors what upsertServiceText() does for the water meters (CR #8) -
    // this slot's Home card header uses the same shared groupLabel()/
    // refreshGroupLabel() machinery, which otherwise has no other way to
    // learn this group's renamed Display Name, since pressure entities
    // never reach upsertServiceText() at all.
    if (nameEntity) {
      groupDisplayNames.set(groupName, (nameEntity.value || "").trim());
      applyGroupLabel(groupName);
    }
  }

  // A scanned-but-not-yet-registered address's row - Address is read-only
  // (it's whatever the scan found), Name is a local draft (nothing is
  // written to the device until Add is pressed), Status is always "New".
  // Add sets the umbrella group's shared Add Name/Add Target Address
  // scratch entities and presses its shared Add button - see that
  // button's own comment in water-collector.yaml for why one shared
  // trigger behind 8 per-row buttons is safe and correct.
  function upsertNewPressureRow(tbody, address, atCeiling) {
    const key = "new:" + address;
    let row = pressureTableRows.get(key);
    if (!row) {
      row = el(
        "tr",
        "dc-pressure-row-new",
        `<td class="dc-pressure-name"></td><td class="dc-pressure-addr"></td><td class="dc-pressure-status"><span class="dc-pressure-badge dc-pressure-badge-new">New</span></td><td class="dc-pressure-action"></td><td class="dc-pressure-order"></td>`
      );
      pressureTableRows.set(key, row);
      tbody.appendChild(row);

      row.querySelector(".dc-pressure-addr").textContent = String(address);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 32;
      nameInput.placeholder = "Sensor name";
      nameInput.value = pressureNewRowDrafts.get(address) || "";
      nameInput.addEventListener("input", () => {
        pressureNewRowDrafts.set(address, nameInput.value);
        // Live, not just on the next render - a name typed and then
        // immediately clicked past shouldn't have to wait for an SSE
        // round trip to unlock Add. atCeiling itself is a snapshot from
        // this row's creation, same as every other read of it in this
        // function - reconciled again on the next real render regardless.
        if (!row._addBtn._busy) row._addBtn.disabled = atCeiling || !nameInput.value.trim();
      });
      row.querySelector(".dc-pressure-name").appendChild(nameInput);
      row._nameInput = nameInput;

      // Add stays disabled with no name typed - a device isn't
      // necessarily a pressure sensor (more Modbus device types are
      // planned), so silently falling back to a generic "Pressure Sensor
      // N" label on an empty name would be actively wrong for those,
      // confirmed a problem, 2026-08-13.
      const addBtn = el("button", "dc-btn dc-btn-compact", "Add");
      addBtn.type = "button";
      addBtn.disabled = true;
      addBtn.addEventListener("click", () => {
        if (addBtn.disabled) return;
        const nameEntity = pressureSlotEntity(PRESSURE_ADD_GROUP, "Add Name");
        const addrEntity = pressureSlotEntity(PRESSURE_ADD_GROUP, "Add Target Address");
        const addEntity = pressureSlotEntity(PRESSURE_ADD_GROUP, "Add");
        if (!nameEntity || !addrEntity || !addEntity) return; // not seen yet - shouldn't happen once connected
        const name = row._nameInput.value;
        // Disabled for the round-trip's duration, not just the ceiling
        // check below - guards against a double-click firing this whole
        // chain twice, which (even with the shared-flag fix in
        // pressure_sensor.yaml's try_register) could still let two
        // separate Add presses each claim a slot for the same address.
        addBtn._busy = true;
        addBtn.disabled = true;
        fetch(`${nameEntity.namePath}/set?value=${encodeURIComponent(name)}`, { method: "POST" })
          .then(() => fetch(`${addrEntity.namePath}/set?value=${encodeURIComponent(address)}`, { method: "POST" }))
          .then(() => fetch(`${addEntity.namePath}/press`, { method: "POST" }))
          .finally(() => {
            addBtn._busy = false;
            addBtn.disabled = atCeiling;
          });
        pressureNewRowDrafts.delete(address);
      });
      row._addBtn = addBtn;
      row.querySelector(".dc-pressure-action").appendChild(addBtn);
    }
    // Never overrides an in-flight request's own disabled state (see the
    // click handler's _busy flag above) - a re-render (any SSE update)
    // landing mid-request would otherwise reset disabled back to
    // whatever atCeiling says here, undoing that guard.
    if (!row._addBtn._busy) {
      const nameEmpty = !row._nameInput.value.trim();
      row._addBtn.disabled = atCeiling || nameEmpty;
      row._addBtn.title = atCeiling
        ? "All 8 sensor slots are already registered - delete one first to add another."
        : nameEmpty
          ? "Enter a name first."
          : "";
    }
  }

  // An address where the last scan got a reply but it failed its own
  // CRC check (latestCollisionAddresses() above) and no slot already
  // claims it - informational only, deliberately no Add button: there's
  // no single device identity here to register (adding it would just
  // register whichever device happens to win bus arbitration on a given
  // poll, silently), see include/rs485_modbus.h's scan_bus() for why
  // this reading is a strong signal but not proof.
  function upsertCollisionPressureRow(tbody, address) {
    const key = "collision:" + address;
    let row = pressureTableRows.get(key);
    if (!row) {
      row = el(
        "tr",
        "dc-pressure-row-collision",
        `<td class="dc-pressure-name"><span class="dc-pressure-collision-note">Multiple devices may share this address</span></td>` +
          `<td class="dc-pressure-addr"></td>` +
          `<td class="dc-pressure-status"><span class="dc-pressure-badge dc-pressure-badge-collision">Collision</span></td>` +
          `<td class="dc-pressure-action"></td>` +
          `<td class="dc-pressure-order"></td>`
      );
      pressureTableRows.set(key, row);
      tbody.appendChild(row);
      row.querySelector(".dc-pressure-addr").textContent = String(address);
    }
  }

  function updatePressureEmptyState(tbody, isEmpty) {
    let placeholder = tbody.querySelector(".dc-pressure-empty");
    if (isEmpty && !placeholder) {
      placeholder = el(
        "tr",
        "dc-pressure-empty",
        `<td colspan="5">No sensors yet – press "Scan Bus" to find one on the RS485 bus.</td>`
      );
      tbody.appendChild(placeholder);
    } else if (!isEmpty && placeholder) {
      placeholder.remove();
    }
  }

  // The actual JOIN (see this section's header comment) - rebuilt on
  // every relevant SSE update. Registered rows are keyed by groupName and
  // new-device rows by address, both stable across rebuilds, so an
  // in-progress edit (name being typed, address being typed) survives a
  // rebuild triggered by something unrelated - see the activeElement
  // guards in upsertRegisteredPressureRow()/the draft Map above.
  function renderPressureTableBody() {
    const tbody = ensurePressureTable();
    if (!tbody) return;
    const registered = registeredPressureSlots();
    const registeredAddresses = new Set(registered.map((s) => s.address));
    const scanAddresses = latestScanAddresses();
    const collisionAddresses = latestCollisionAddresses();
    const collisionSet = new Set(collisionAddresses);
    const atCeiling = registered.length >= PRESSURE_MAX_SLOTS;

    const seenKeys = new Set();
    const orderedRegistered = orderedRegisteredSlots();
    orderedRegistered.forEach((slot, i) => {
      seenKeys.add("reg:" + slot.groupName);
      upsertRegisteredPressureRow(
        tbody,
        slot.groupName,
        slot.online, // tri-state: true/false/undefined ("never polled yet") - see upsertRegisteredPressureRow()'s own comment
        collisionSet.has(slot.address),
        i === 0,
        i === orderedRegistered.length - 1
      );
    });
    const newAddresses = [...new Set(scanAddresses)].filter((a) => !registeredAddresses.has(a)).sort((a, b) => a - b);
    for (const address of newAddresses) {
      seenKeys.add("new:" + address);
      upsertNewPressureRow(tbody, address, atCeiling);
    }
    const unclaimedCollisions = [...new Set(collisionAddresses)]
      .filter((a) => !registeredAddresses.has(a))
      .sort((a, b) => a - b);
    for (const address of unclaimedCollisions) {
      seenKeys.add("collision:" + address);
      upsertCollisionPressureRow(tbody, address);
    }

    // upsert*Row() above only appends a row to the DOM the first time
    // it's created - without this, every row would keep whatever
    // position it happened to be inserted at forever afterwards, even
    // once a Sort Order change (or a slot getting registered/deleted
    // elsewhere in the list) says it belongs somewhere else.
    //
    // Only actually *moves* a row when it isn't already in the right
    // spot - unconditionally calling appendChild()/insertBefore() on
    // every row on every render (an earlier version of this loop) is
    // wrong even for rows that don't need to move at all: detaching and
    // reattaching a node blurs whatever input inside it currently has
    // focus. Since this whole function re-runs on every relevant SSE
    // update - which, for a registered slot, includes its own live
    // Online status changing on essentially every poll, roughly twice a
    // second - that made editing a row's Name/Address effectively
    // impossible, confirmed on real hardware, 2026-08-13: focus kept
    // getting kicked out mid-edit by the *next* poll's own re-render, not
    // by anything about editing itself. This walks the desired order
    // once and only touches a node when its current position doesn't
    // already match - for the overwhelmingly common case (nothing was
    // just reordered) that's zero DOM moves.
    const desiredOrder = [
      ...orderedRegistered.map((s) => pressureTableRows.get("reg:" + s.groupName)),
      ...newAddresses.map((a) => pressureTableRows.get("new:" + a)),
      ...unclaimedCollisions.map((a) => pressureTableRows.get("collision:" + a)),
    ];
    let anchor = tbody.firstElementChild;
    for (const row of desiredOrder) {
      if (anchor === row) {
        anchor = anchor.nextElementSibling;
      } else {
        tbody.insertBefore(row, anchor);
      }
    }

    let removedAny = false;
    for (const [key, row] of pressureTableRows) {
      if (!seenKeys.has(key)) {
        row.remove();
        pressureTableRows.delete(key);
        removedAny = true;
      }
    }
    // A row disappearing (e.g. Delete) can leave a *different* row's icon
    // sitting exactly where the mouse cursor already was - the confirm()
    // dialog that gated the delete is a blocking native prompt, so the
    // click that led here never involved the mouse actually moving over
    // whatever's there now. Confirmed on real hardware, 2026-08-13: the
    // new first row's trash icon showed a stuck hover-red look until the
    // mouse was moved (or clicked elsewhere). suppressStaleHover() below
    // clears that until an actual pointer move happens.
    if (removedAny) suppressStaleHover(tbody);
    updatePressureEmptyState(tbody, seenKeys.size === 0);
  }

  function suppressStaleHover(tbody) {
    tbody.classList.add("dc-pressure-table-settling");
    document.addEventListener("mousemove", () => tbody.classList.remove("dc-pressure-table-settling"), { once: true });
  }

  // Home card existence, gated purely on Modbus Address != 0 - see this
  // section's own header comment for why this (not create-then-hide) is
  // what actually avoids a flash. Reuses upsertHomeMetric()/
  // ensureHomeGroup() as-is once registered; on the way back to
  // unregistered (Delete), removes the card outright rather than just
  // hiding it - a deleted slot has genuinely nothing left to show.
  function syncPressureHomeCard(groupName) {
    const addrEntity = pressureSlotEntity(groupName, "Modbus Address");
    if (!addrEntity || !(addrEntity.value > 0)) {
      const home = homeGroups.get(groupName);
      if (home) {
        home.card.remove();
        homeGroups.delete(groupName);
      }
      // upsertHomeMetric() below caches the "Pressure" entity's own DOM
      // row on entity.el and only (re)creates it when that's falsy -
      // removing the *card* here without also clearing this left a
      // dangling reference to a now-detached node: a later
      // re-registration found entity.el already truthy, so it just kept
      // updating that orphaned, invisible node forever instead of
      // rebuilding and reattaching a fresh row to the new card. Confirmed
      // the actual cause of a real symptom - the card's header/icon
      // reappeared correctly but the pressure value itself never came
      // back, "fixed" only by a full page reload (which throws away
      // every cached DOM reference and starts clean) - 2026-08-13. Can
      // be reached even without ever actually being deleted by the user:
      // e.g. a brief address-not-yet-settled moment during Add, or
      // anything else that transiently makes this check true and false
      // again in quick succession.
      const pressureEntity = pressureSlotEntity(groupName, "Pressure");
      if (pressureEntity) pressureEntity.el = null;
      return;
    }
    const pressureEntity = pressureSlotEntity(groupName, "Pressure");
    if (pressureEntity) {
      // Same collision signal the Service table's own badge already
      // uses (latestCollisionAddresses(), fed by the debounced "Scan
      // Collisions" CSV - see set_scan_collision_address()'s cooldown in
      // pressure_sensor.yaml) - a slot flagged here shows "--" instead
      // of whatever its last poll happened to read, see
      // upsertHomeMetric()'s own comment for why.
      const collision = latestCollisionAddresses().includes(Math.round(addrEntity.value));
      upsertHomeMetric(pressureEntity, collision);
    }
  }

  function renderPressureEntity(entity) {
    if (entity.groupName === PRESSURE_ADD_GROUP) {
      ensurePressureTable(); // make sure the toolbar + table exist even with zero scan results yet
      const label = displayName(entity);
      if (label === "Scan Bus") mountPressureToolbarButton(entity);
      else if (label === "Scan Results" || label === "Scan Collisions") renderPressureTableBody();
      else if (label === "Scan In Progress") syncScanButtonBusyState(entity.value === true);
      // Add Name / Add Target Address / Add itself have no visible UI of
      // their own - they're write-only targets set by each new-device
      // row's own Add button above, never rendered directly.
      return;
    }
    renderPressureTableBody();
    syncPressureHomeCard(entity.groupName);
  }

  // --- Pulse meter table (Service page) ---------------------------------
  //
  // Same Add/Delete/edit-lock commissioning pattern as the Modbus pressure
  // sensors above (REQUIREMENTS.md's "Pulse meter" architectural note,
  // 2026-08-13) - unified so "nothing shows until commissioned" is one
  // rule, not two slightly-different ones depending on which kind of
  // device it is. Deliberately much simpler than the pressure table
  // though: there is no bus, so no scan/discovery/collision concept
  // applies at all - each meter's identity (which GPIO it reads) is fixed
  // at compile time (water_meter.yaml), so a "New device" row always
  // exists for whichever meter isn't yet Registered, no Scan Bus press
  // needed to find it. Reuses the pressure table's own CSS classes
  // (dc-pressure-icon-btn/dc-pressure-row-editing/etc. - and the
  // dc-pressure-table base class itself, for the shared border/input/
  // disabled/hover-suppression rules) rather than duplicating them under
  // a parallel name - purely visual/behavioral, nothing pressure-specific
  // about them despite the name.
  //
  // Once Registered, a meter's other fields (Total Consumption/Flow Rate
  // on the Home page, Reading+Update/Zero-Flow Timeout on the Service
  // page, Total Pulses on Diagnostics) render through the *same* generic
  // upsertHomeMetric()/upsertServiceNumber()/upsertServiceButton()/
  // upsertDiagRow() this file already uses everywhere else - only
  // Registered/Delete/Display Name are intercepted here, everything else
  // just needs a single gate (isPulseMeterRegistered()) before falling
  // through to those unchanged.

  const PULSE_METER_RE = /^Water Meter \d+$/;
  const PULSE_METER_ADD_GROUP = "Pulse Meters";

  function pulseMeterSlotEntity(groupName, label) {
    for (const e of entities.values()) {
      if (e.groupName === groupName && displayName(e) === label) return e;
    }
    return null;
  }

  // Both meters, in a fixed order (alphabetical happens to already be
  // the right physical order: "Water Meter 1" before "...2") - unlike
  // the pressure table there's no Sort Order/reordering here, since with
  // only ever two possible, permanently-fixed items there's no
  // "physical layout" ambiguity a manual order could represent.
  function pulseMeterGroups() {
    const names = new Set();
    for (const e of entities.values()) {
      if (e.groupName && PULSE_METER_RE.test(e.groupName)) names.add(e.groupName);
    }
    return [...names].sort();
  }

  function isPulseMeterRegistered(groupName) {
    const e = pulseMeterSlotEntity(groupName, "Registered");
    return !!(e && e.value === true);
  }

  let pulseMeterTableBody = null;

  function ensurePulseMeterTable() {
    let g = serviceGroups.get(PULSE_METER_ADD_GROUP);
    if (g) return pulseMeterTableBody;
    const section = el("div", "dc-service-group dc-pulsemeter-group");
    const label = el("div", "dc-section-label", PULSE_METER_ADD_GROUP);
    const table = el(
      "table",
      "dc-pressure-table dc-pulsemeter-table",
      `<thead><tr><th>Name</th><th></th></tr></thead><tbody></tbody>`
    );
    section.append(label, table);
    g = { weight: groupWeights.get(PULSE_METER_ADD_GROUP) ?? 500, section };
    serviceGroups.set(PULSE_METER_ADD_GROUP, g);
    document.getElementById("dc-page-service").appendChild(section);
    reorderServiceGroups();
    pulseMeterTableBody = table.querySelector("tbody");
    return pulseMeterTableBody;
  }

  const pulseMeterTableRows = new Map(); // "reg:"+groupName or "new:"+groupName -> <tr>
  const pulseMeterNewRowDrafts = new Map(); // groupName -> in-progress typed name

  // A registered meter's row - Name is read-only until the pencil button
  // is pressed, then editable with an explicit Save/Cancel (and
  // Enter/Escape - see the pressure table's own row for why), same lock
  // as the pressure table's rows and for the same reason (an accidental
  // blur used to write immediately). No Address/Status/Order columns -
  // nothing here to show (a local GPIO pulse counter has no equivalent
  // failure mode to "Lost"/"Collision", and there's nothing to reorder).
  function upsertRegisteredPulseMeterRow(tbody, groupName) {
    const key = "reg:" + groupName;
    const nameEntity = pulseMeterSlotEntity(groupName, "Display Name");
    const delEntity = pulseMeterSlotEntity(groupName, "Delete");
    let row = pulseMeterTableRows.get(key);
    if (!row) {
      row = el("tr", "", `<td class="dc-pressure-name"></td><td class="dc-pressure-action"></td>`);
      pulseMeterTableRows.set(key, row);
      tbody.appendChild(row);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 32;
      nameInput.disabled = true;
      row.querySelector(".dc-pressure-name").appendChild(nameInput);
      row._nameInput = nameInput;

      const actionCell = row.querySelector(".dc-pressure-action");
      const editBtn = el("button", "dc-pressure-icon-btn dc-pressure-edit-btn", svgIcon("pencil"));
      editBtn.type = "button";
      editBtn.title = "Edit name";
      actionCell.appendChild(editBtn);

      const delBtn = el("button", "dc-pressure-icon-btn dc-pressure-del-btn", svgIcon("trash"));
      delBtn.type = "button";
      delBtn.title = "Delete";
      actionCell.appendChild(delBtn);
      row._delBtn = delBtn;

      const saveBtn = el("button", "dc-pressure-icon-btn dc-pressure-save-btn", svgIcon("check"));
      saveBtn.type = "button";
      saveBtn.title = "Save";
      actionCell.appendChild(saveBtn);

      const cancelBtn = el("button", "dc-pressure-icon-btn dc-pressure-cancel-btn", svgIcon("close"));
      cancelBtn.type = "button";
      cancelBtn.title = "Cancel";
      actionCell.appendChild(cancelBtn);

      const enterEdit = () => {
        row._editOrigName = nameInput.value;
        nameInput.disabled = false;
        row.classList.add("dc-pressure-row-editing");
        row._editing = true;
        nameInput.focus();
        nameInput.select();
      };
      const exitEdit = () => {
        nameInput.disabled = true;
        row.classList.remove("dc-pressure-row-editing");
        row._editing = false;
      };
      editBtn.addEventListener("click", enterEdit);
      cancelBtn.addEventListener("click", () => {
        nameInput.value = row._editOrigName;
        exitEdit();
      });
      const handleEditKeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveBtn.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelBtn.click();
        }
      };
      nameInput.addEventListener("keydown", handleEditKeydown);
      saveBtn.addEventListener("click", () => {
        if (!nameInput.value.trim()) {
          alert("Name can't be empty.");
          return; // stay in edit mode so it can be fixed
        }
        const ne = pulseMeterSlotEntity(groupName, "Display Name");
        if (!ne) return;
        saveBtn.disabled = true;
        cancelBtn.disabled = true;
        fetch(`${ne.namePath}/set?value=${encodeURIComponent(nameInput.value)}`, { method: "POST" }).finally(() => {
          saveBtn.disabled = false;
          cancelBtn.disabled = false;
          exitEdit();
        });
      });
    }
    // Same reasoning as the pressure table's own Delete wiring - this
    // entity is intercepted before it would ever reach
    // upsertServiceButton(), the only other place that sets btnEl.
    if (delEntity) delEntity.btnEl = row._delBtn;
    row._delBtn.onclick = () => {
      if (delEntity) pressButton(delEntity);
    };
    if (!row._editing) {
      row._nameInput.value = (nameEntity && nameEntity.value) || "";
    }
  }

  // A not-yet-Registered meter's row - Name is a local draft (nothing is
  // written until Add is pressed, same as the pressure table's own "New
  // device" rows), pre-filled from whatever Display Name this meter
  // already has (Delete deliberately preserves it - see that button's
  // own comment in water_meter.yaml) so re-adding the same physical
  // meter doesn't require retyping a name it already had, while still
  // allowing it to be changed here first. Add stays disabled with no
  // name typed, same reasoning as the pressure table's own Add.
  function upsertNewPulseMeterRow(tbody, groupName) {
    const key = "new:" + groupName;
    let row = pulseMeterTableRows.get(key);
    if (!row) {
      const nameEntity = pulseMeterSlotEntity(groupName, "Display Name");
      row = el("tr", "", `<td class="dc-pressure-name"></td><td class="dc-pressure-action"></td>`);
      pulseMeterTableRows.set(key, row);
      tbody.appendChild(row);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 32;
      nameInput.placeholder = "Meter name";
      nameInput.value = pulseMeterNewRowDrafts.has(groupName)
        ? pulseMeterNewRowDrafts.get(groupName)
        : (nameEntity && nameEntity.value) || "";
      row.querySelector(".dc-pressure-name").appendChild(nameInput);
      row._nameInput = nameInput;

      const addBtn = el("button", "dc-btn dc-btn-compact", "Add");
      addBtn.type = "button";
      addBtn.disabled = !nameInput.value.trim();
      nameInput.addEventListener("input", () => {
        pulseMeterNewRowDrafts.set(groupName, nameInput.value);
        if (!addBtn._busy) addBtn.disabled = !nameInput.value.trim();
      });
      addBtn.addEventListener("click", () => {
        if (addBtn.disabled) return;
        const ne = pulseMeterSlotEntity(groupName, "Display Name");
        const regEntity = pulseMeterSlotEntity(groupName, "Registered");
        if (!ne || !regEntity) return;
        const name = row._nameInput.value.trim();
        if (!name) return;
        addBtn._busy = true;
        addBtn.disabled = true;
        fetch(`${ne.namePath}/set?value=${encodeURIComponent(name)}`, { method: "POST" })
          .then(() => fetch(`${regEntity.namePath}/turn_on`, { method: "POST" }))
          .finally(() => {
            addBtn._busy = false;
          });
        pulseMeterNewRowDrafts.delete(groupName);
      });
      row._addBtn = addBtn;
      row.querySelector(".dc-pressure-action").appendChild(addBtn);
    }
  }

  // The actual JOIN, same idea as renderPressureTableBody()'s own - a
  // row is either "registered" (Registered switch on) or "new" (off);
  // every known meter always has exactly one row, never zero, never
  // both. Reorders with the same "only move a node when it isn't
  // already in the right spot" reconciliation as the pressure table,
  // for the same reason (avoids blurring an in-progress edit on every
  // unrelated re-render).
  function renderPulseMeterTableBody() {
    const tbody = ensurePulseMeterTable();
    if (!tbody) return;
    const groups = pulseMeterGroups();
    const seenKeys = new Set();
    for (const groupName of groups) {
      if (isPulseMeterRegistered(groupName)) {
        seenKeys.add("reg:" + groupName);
        upsertRegisteredPulseMeterRow(tbody, groupName);
      } else {
        seenKeys.add("new:" + groupName);
        upsertNewPulseMeterRow(tbody, groupName);
      }
    }
    const desiredOrder = groups.map((g) => pulseMeterTableRows.get((isPulseMeterRegistered(g) ? "reg:" : "new:") + g));
    let anchor = tbody.firstElementChild;
    for (const row of desiredOrder) {
      if (anchor === row) anchor = anchor.nextElementSibling;
      else tbody.insertBefore(row, anchor);
    }
    for (const [key, row] of pulseMeterTableRows) {
      if (!seenKeys.has(key)) {
        row.remove();
        pulseMeterTableRows.delete(key);
      }
    }
  }

  // Creates/removes this meter's Home card, Service section (Reading/
  // Update/Zero-Flow Timeout) and Diagnostics section (Total Pulses) as
  // a whole, purely from its own Registered state - the unified
  // counterpart of syncPressureHomeCard(), extended to all three pages
  // since a water meter (unlike a pressure slot) has real fields on all
  // of them, not just a Home card.
  //
  // Critically, also clears every cached DOM reference this file keeps
  // on an entity object (.el/.inputEl/.readoutEl/.toggleEl/.btnEl) when
  // un-registering - without this, re-Registering the same meter later
  // would silently keep updating detached, invisible nodes from before
  // instead of rebuilding fresh ones: the exact bug already found and
  // fixed once for the pressure sensors' own Home card (entity.el going
  // stale across a remove-then-recreate cycle), generalized here since
  // a water meter caches several *kinds* of reference across three pages
  // instead of just one.
  function syncPulseMeterVisibility(groupName) {
    if (isPulseMeterRegistered(groupName)) return; // still registered - individual entities (re)build lazily via the generic dispatch in renderPulseMeterEntity()
    const home = homeGroups.get(groupName);
    if (home) {
      home.card.remove();
      homeGroups.delete(groupName);
    }
    const svc = serviceGroups.get(groupName);
    if (svc) {
      svc.section.remove();
      serviceGroups.delete(groupName);
    }
    const diag = diagGroups.get(groupName);
    if (diag) {
      diag.section.remove();
      diagGroups.delete(groupName);
    }
    for (const e of entities.values()) {
      if (e.groupName === groupName) {
        e.el = null;
        e.inputEl = null;
        e.readoutEl = null;
        e.toggleEl = null;
        e.btnEl = null;
      }
    }
  }

  // Total Consumption/Flow Rate/Reading/Update/Zero-Flow Timeout/Total
  // Pulses only ever render once Registered - falls through to the exact
  // same generic dispatch every other entity in this file goes through
  // otherwise. Split out from renderPulseMeterEntity() below so it can
  // also be called directly to "catch up" entities whose own update
  // already arrived and was skipped before Registered was known - see
  // that function's own comment for why that's needed at all.
  function renderPulseMeterCalibrationEntity(entity) {
    if (!isPulseMeterRegistered(entity.groupName)) return;
    const page = pageFor(entity);
    if (page === "home") upsertHomeMetric(entity);
    else if (page === "diagnostics") upsertDiagRow(entity);
    else if (page === "service") {
      if (entity.domain === "number") upsertServiceNumber(entity);
      else if (entity.domain === "button") upsertServiceButton(entity);
      else if (entity.domain === "switch") upsertServiceSwitch(entity);
      else if (entity.domain === "text") upsertServiceText(entity);
    }
  }

  function renderPulseMeterEntity(entity) {
    const groupName = entity.groupName;
    const label = displayName(entity);
    if (label === "Registered" || label === "Delete" || label === "Display Name") {
      if (label === "Display Name") {
        // Mirrors what upsertServiceText() does for every other renamed
        // group (water meters used to reach it directly for this same
        // entity, before Display Name was intercepted here) - this
        // group's Home card header/Service section label has no other
        // way to learn a renamed Display Name, since it never reaches
        // that generic path anymore.
        groupDisplayNames.set(groupName, (entity.value || "").trim());
        applyGroupLabel(groupName);
      }
      renderPulseMeterTableBody();
      syncPulseMeterVisibility(groupName);
      // ESPHome dumps entities in a fixed cross-domain order, not
      // registration order (same phenomenon noted elsewhere in this
      // file) - "Registered" (switch domain) isn't guaranteed to arrive
      // before e.g. "Total Consumption" (sensor domain). Without this,
      // an entity whose own update happened to arrive *before*
      // Registered was known would be silently skipped by the gate in
      // renderPulseMeterCalibrationEntity() above and then never
      // revisited, since nothing else would trigger it again until its
      // own next unrelated change - potentially a long wait (e.g. Total
      // Consumption, which only updates on the next pulse). Once
      // Registered is known, re-run every other already-arrived entity
      // in this group through the same dispatch to pick up anything
      // that was missed.
      if (isPulseMeterRegistered(groupName)) {
        for (const e of entities.values()) {
          if (e.groupName === groupName && e !== entity) renderPulseMeterCalibrationEntity(e);
        }
      }
      return;
    }
    renderPulseMeterCalibrationEntity(entity);
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
        `<div class="label"><span class="label-text"></span></div><div class="dc-field-row"></div><div class="dc-hint"></div>`
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
        // Nothing stopped an empty box, or a single pasted garbage
        // character, from reaching /set before this - the ESP-side
        // number component does reject unparseable/out-of-range values
        // (safely, logged as "No operation" / a min/max warning, not
        // itself a crash as far as could be confirmed), but firing a
        // request that can never do anything useful is still worth not
        // doing, and it muddies any future crash investigation to have
        // it in the log right before something else goes wrong. Revert
        // and skip the request entirely for anything that isn't an
        // actual in-range number.
        const parsed = parseFloat(input.value);
        const outOfRange =
          Number.isNaN(parsed) ||
          (entity.min !== undefined && parsed < entity.min) ||
          (entity.max !== undefined && parsed > entity.max);
        if (outOfRange) {
          input.value = entity.value ?? "";
          return;
        }
        // A handful of numbers take effect the instant they're set (no
        // separate "apply" step, unlike Reading/Update) - CR #6 asks for
        // a confirmation before those specifically.
        if (CONFIRM_ON_CHANGE.has(displayName(entity))) {
          const message = `Change ${entity.groupName} ${displayName(entity)} to ${input.value}${entity.uom ? " " + entity.uom : ""}?`;
          if (!confirm(message)) {
            input.value = entity.value ?? ""; // revert the visible value to the last known server state
            return;
          }
        }
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
    const label = displayName(entity);
    entity.el.querySelector(".label-text").textContent = label;
    attachHelp(entity.el.querySelector(".label"), HELP_TEXT[label]);
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
    entity.el.dataset.weight = entity.groupWeight ?? 500;
    reorderServiceFields(group);
  }

  // Display Name (CR #8) - a plain text field, styled like a number field
  // but with no min/max hint and no confirm-on-change (purely cosmetic,
  // nothing to protect against). Renaming immediately relabels this
  // meter's Home card and Service/Diagnostics section headers.
  function upsertServiceText(entity) {
    const group = ensureServiceGroup(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.el) {
      entity.el = el(
        "div",
        "dc-field",
        `<div class="label"><span class="label-text"></span></div><div class="dc-field-row"></div>`
      );
      const row = entity.el.querySelector(".dc-field-row");
      const input = document.createElement("input");
      input.type = "text";
      row.appendChild(input);
      input.addEventListener("change", () => {
        fetch(`${entity.namePath}/set?value=${encodeURIComponent(input.value)}`, { method: "POST" });
      });
      entity.inputEl = input;
      group.fields.appendChild(entity.el);
    }
    if (entity.maxLength !== undefined) entity.inputEl.maxLength = entity.maxLength;
    const label = displayName(entity);
    entity.el.querySelector(".label-text").textContent = label;
    attachHelp(entity.el.querySelector(".label"), HELP_TEXT[label]);
    if (document.activeElement !== entity.inputEl) entity.inputEl.value = entity.value ?? "";
    if (label === "Display Name") {
      groupDisplayNames.set(entity.groupName, (entity.value || "").trim());
      applyGroupLabel(entity.groupName);
    }
    entity.el.dataset.weight = entity.groupWeight ?? 500;
    reorderServiceFields(group);
  }

  // Generic switch field - a pill toggle. Water meters' own "Registered"
  // switch (which used to reach this, as "Show on Dashboard", CR #9) is
  // intercepted before it ever gets here now - see
  // renderPulseMeterEntity()'s own comment for why - so in practice
  // nothing currently reaches this path, but it's kept as the generic
  // fallback for any future plain switch-domain field.
  function upsertServiceSwitch(entity) {
    const group = ensureServiceGroup(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.el) {
      entity.el = el(
        "div",
        "dc-field",
        `<div class="label"><span class="label-text"></span></div><div class="dc-field-row"></div>`
      );
      const toggle = el("button", "dc-toggle", "");
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.addEventListener("click", () => {
        fetch(`${entity.namePath}/toggle`, { method: "POST" });
      });
      entity.el.querySelector(".dc-field-row").appendChild(toggle);
      entity.toggleEl = toggle;
      group.fields.appendChild(entity.el);
    }
    const label = displayName(entity);
    entity.el.querySelector(".label-text").textContent = label;
    attachHelp(entity.el.querySelector(".label"), HELP_TEXT[label]);
    const on = entity.value === true;
    entity.toggleEl.classList.toggle("dc-toggle-on", on);
    entity.toggleEl.setAttribute("aria-checked", on ? "true" : "false");
    entity.el.dataset.weight = entity.groupWeight ?? 500;
    reorderServiceFields(group);
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
    attachHelp(row, HELP_TEXT["Update"]);
    if (buttonEntity.el) {
      buttonEntity.el.remove();
      buttonEntity.el = null;
    }
  }

  function pressButton(entity) {
    const label = displayName(entity);
    if (CONFIRM_ON_PRESS.has(label) && !confirm(confirmMessageForPress(entity, label))) return;
    const btn = entity.btnEl;
    btn.classList.add("dc-pressed");
    fetch(`${entity.namePath}/press`, { method: "POST" }).finally(() => {
      setTimeout(() => btn.classList.remove("dc-pressed"), 400);
    });
  }

  // Update's confirmation names the actual value about to be applied
  // (read straight off the paired Reading field's input) rather than a
  // generic "are you sure?" - Restart just needs a plain yes/no.
  function confirmMessageForPress(entity, label) {
    if (label === "Restart") return "Restart the device now?";
    if (label === "Forget Wi-Fi")
      return "Forget the current Wi-Fi network and restart into setup mode? Calibration and other settings are kept - only the network changes.";
    if (label === "Update") {
      const base = comboBaseKey(entity.id);
      const numberEntity = base && entities.get(`number-${base}_reading`);
      const value = numberEntity && numberEntity.inputEl ? numberEntity.inputEl.value : "the entered value";
      const unit = numberEntity && numberEntity.uom ? " " + numberEntity.uom : "";
      return `Set ${entity.groupName} Reading to ${value}${unit}? This overwrites the accumulated total and cannot be undone.`;
    }
    if (label === "Delete" && isPressureGroup(entity.groupName)) {
      // entity.groupName here is a pressure slot's internal, deliberately
      // meaningless compile-time id (e.g. "Pressure Sensor 3" - which
      // physical slot a sensor happens to occupy is never supposed to be
      // shown anywhere, see pressure_sensor.yaml's own file header) - the
      // confirm dialog showing it directly was a real leak of that
      // internal detail, confirmed confusing on real hardware,
      // 2026-08-13. Show the sensor's own Display Name instead (falling
      // back to its Modbus Address if the name was left blank).
      const nameEntity = pressureSlotEntity(entity.groupName, "Display Name");
      const addrEntity = pressureSlotEntity(entity.groupName, "Modbus Address");
      const shownName =
        (nameEntity && nameEntity.value && nameEntity.value.trim()) ||
        (addrEntity ? `address ${Math.round(addrEntity.value)}` : "this sensor");
      return `Delete "${shownName}"'s registration? Its Dashboard card disappears until re-added.`;
    }
    if (label === "Delete" && PULSE_METER_RE.test(entity.groupName)) {
      // Unlike a pressure slot's Delete, a water meter's own raw group
      // name ("Water Meter 1") is a perfectly reasonable fallback here -
      // it's not an internal/meaningless id the way a pressure slot's is
      // (see the branch above), a water meter's identity is permanently
      // tied to its own physical GPIO. Wording also differs on purpose:
      // pulse counting and the accumulated Total Consumption keep running
      // in the background, unlike a pressure slot's Delete, which really
      // does forget the registration outright - see water_meter.yaml's
      // own Delete comment for why these two domains differ here.
      const nameEntity = pulseMeterSlotEntity(entity.groupName, "Display Name");
      const shownName = (nameEntity && nameEntity.value && nameEntity.value.trim()) || entity.groupName;
      return `Stop showing "${shownName}"? Pulse counting and its accumulated Total Consumption keep running in the background - re-add it later to pick up where it left off.`;
    }
    return "Are you sure?";
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
      const row = el("div", "dc-field-row");
      entity.btnEl = el("button", "dc-btn", entity.name);
      entity.btnEl.addEventListener("click", () => pressButton(entity));
      row.appendChild(entity.btnEl);
      attachHelp(row, HELP_TEXT[displayName(entity)]);
      entity.el.appendChild(row);
      group.fields.appendChild(entity.el);
    }
    entity.el.dataset.weight = entity.groupWeight ?? 500;
    reorderServiceFields(group);
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

  // "Debug Log: Modbus" (water-collector.yaml) - flips the "modbus" log
  // tag (include/rs485_modbus.h) up to VERY_VERBOSE via ESPHome's own
  // logger.set_level action, right from the Log page itself rather than
  // as a generic Service-page switch - this only ever matters while
  // actually watching this page for a live communication problem, so
  // that's where the control belongs. Off by default (see the entity's
  // own restore_mode: ALWAYS_OFF) - at VERY_VERBOSE a single bus scan
  // alone logs ~250 lines, not something to leave running.
  function mountLogDebugToggle(entity) {
    const toolbar = document.getElementById("dc-log-toolbar");
    if (!entity.toggleEl) {
      const wrap = el("label", "dc-log-debug-toggle", `<span>Debug: Modbus</span>`);
      const toggle = el("button", "dc-toggle", "");
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.addEventListener("click", () => {
        fetch(`${entity.namePath}/toggle`, { method: "POST" });
      });
      wrap.appendChild(toggle);
      toolbar.insertBefore(wrap, document.getElementById("dc-log-clear"));
      entity.toggleEl = toggle;
    }
    const on = entity.value === true;
    entity.toggleEl.classList.toggle("dc-toggle-on", on);
    entity.toggleEl.setAttribute("aria-checked", on ? "true" : "false");
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

  // Adds a tap-to-reveal "?" to `container` (typically a `.label`/row
  // element) and a hidden explanation block right after it (CR #7) - a
  // no-op if there's no text for this label, or if it's already been
  // attached (upsert* runs on every SSE update, this only needs to
  // happen once).
  function attachHelp(container, text) {
    if (!text || container.querySelector(".dc-help-btn")) return;
    const btn = el("button", "dc-help-btn", "?");
    btn.type = "button";
    btn.setAttribute("aria-label", "Help");
    const hint = el("div", "dc-help-text", text);
    hint.hidden = true;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      hint.hidden = !hint.hidden;
    });
    container.appendChild(btn);
    container.insertAdjacentElement("afterend", hint);
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

  const SERVICE_DOMAINS = new Set(["number", "button", "switch", "text"]);

  function pageFor(entity) {
    if (entity.category === ENTITY_CATEGORY_DIAGNOSTIC) return "diagnostics";
    if (SERVICE_DOMAINS.has(entity.domain)) return "service";
    return "home";
  }

  function render(entity) {
    if (isHiddenFromUi(entity)) return;
    // Header signal-bars widget - see updateSignalBars() above. Matched on
    // the entity's real (compile-time) name, same as everywhere else in
    // this file - independent of pageFor()/Diagnostics placement below,
    // this entity still renders there too, this is purely an additional
    // header shortcut for it.
    if (entity.domain === "sensor" && entity.name === "Wi-Fi Signal") updateSignalBars(entity.value);
    // Pressure sensor slots (and their "Pressure Sensors" umbrella group)
    // bypass the generic Home/Service/Diagnostics dispatch entirely - see
    // the "Pressure sensor table" section above for why.
    if (entity.groupName && isPressureGroup(entity.groupName)) {
      renderPressureEntity(entity);
      return;
    }
    // Water meters ("Pulse meters") - same reasoning, see the "Pulse
    // meter table" section above.
    if (entity.groupName && PULSE_METER_RE.test(entity.groupName)) {
      renderPulseMeterEntity(entity);
      return;
    }
    // "Debug Log: Modbus" - mounted into the Log page's own toolbar
    // instead of the generic Service list, see mountLogDebugToggle()'s
    // own comment for why.
    if (entity.domain === "switch" && entity.name === "Debug Log: Modbus") {
      mountLogDebugToggle(entity);
      return;
    }
    const page = pageFor(entity);
    if (page === "home") upsertHomeMetric(entity);
    else if (page === "diagnostics") upsertDiagRow(entity);
    else if (page === "service") {
      if (entity.domain === "number") upsertServiceNumber(entity);
      else if (entity.domain === "button") upsertServiceButton(entity);
      else if (entity.domain === "switch") upsertServiceSwitch(entity);
      else if (entity.domain === "text") upsertServiceText(entity);
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
    if (data.max_length !== undefined) entity.maxLength = data.max_length;
    entity.value = coerceValue(entity.domain, data.value);
    render(entity);
    scheduleSettle();
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
    // While this browser's own SSE link is down, no further entity updates
    // can arrive at all - freezing the signal-bars widget on whatever RSSI
    // it last saw would look live but not be, which is worse than showing
    // nothing. updateSignalBars() itself only gets called back with a real
    // number once a fresh "Wi-Fi Signal" state event actually arrives.
    if (!connected) updateSignalBars(NaN);
  }

  // Header Wi-Fi signal readout (bars only - the dBm number was tried and
  // pulled again, bars alone read cleaner at a glance), fed by the
  // device's own "Wi-Fi Signal" sensor entity through the exact same SSE
  // pipeline as every other entity - see the hook in render() below.
  // Deliberately a separate thing from #dc-status/setConnected() above:
  // that tracks whether *this browser's* SSE link to the device is
  // currently open, this tracks the *device's own* upstream Wi-Fi RSSI -
  // two different links, independently healthy or not. Paired with the
  // sensor's 2s update_interval (water-collector.yaml - was 60s, far too
  // slow to watch anything happen live), this is what makes something
  // like "does a hand near the board tank the signal" actually visible in
  // real time, instead of only inferable after the fact from a disconnect
  // reason. The exact dBm is still available as a hover/long-press tooltip
  // (title attribute) and on the Diagnostics page's own "Wi-Fi Signal" row.
  //
  // Thresholds are the common phone-style dBm convention (less negative =
  // stronger); tier 0 (unknown/no reading yet) and the gap below -85 both
  // render as all-grey, deliberately not treated as an error state here -
  // #dc-status already owns "something is wrong", this widget only ever
  // says how strong the signal is when there is one.
  const SIGNAL_TIERS = [
    { min: -55, tier: 4 },
    { min: -65, tier: 3 },
    { min: -75, tier: 2 },
    { min: -85, tier: 1 },
  ];
  function updateSignalBars(dbm) {
    const wrap = document.getElementById("dc-wifi-signal");
    if (!wrap) return;
    if (typeof dbm !== "number" || Number.isNaN(dbm)) {
      wrap.dataset.tier = "0";
      wrap.title = "Wi-Fi signal: unknown";
      return;
    }
    const found = SIGNAL_TIERS.find((t) => dbm >= t.min);
    wrap.dataset.tier = String(found ? found.tier : 0);
    const text = `${Math.round(dbm)} dBm`;
    wrap.title = `Wi-Fi signal: ${text}`;
  }

  function selectPage(id) {
    currentPage = id;
    for (const p of PAGES) {
      const active = p.id === id;
      document.querySelector(`.dc-nav-item[data-page="${p.id}"]`).classList.toggle("active", active);
      document.getElementById(`dc-page-${p.id}`).classList.toggle("active", active);
    }
    document.getElementById("dc-title").textContent = PAGES.find((p) => p.id === id).label;
    if (id === "service") prefillReadingFields();
    // CR #12: remembered across reloads (a plain refresh, not just
    // switching tabs within the same load) - a page reload otherwise
    // always dropped back to Home regardless of where you were.
    try {
      localStorage.setItem("dc-page", id);
    } catch (e) {
      // Private browsing / storage disabled - losing the remembered page
      // isn't worth failing anything else over.
    }
  }

  // Reads back CR #12's remembered page for the very first render - falls
  // back to Home for a first-ever visit or an unrecognized/corrupt value.
  function loadRememberedPage() {
    let saved = null;
    try {
      saved = localStorage.getItem("dc-page");
    } catch (e) {
      // ignore, see selectPage()
    }
    return PAGES.some((p) => p.id === saved) ? saved : "home";
  }

  // CR #3: each time the Service page is opened, every Reading field is
  // pre-filled with its meter's current Total Consumption - a sensible
  // starting point (instead of showing 0, the field's optimistic default,
  // which would otherwise be one accidental Update press away from
  // zeroing the total) and a smaller nudge to correct than typing the
  // whole number from scratch. Deliberately NOT re-applied continuously
  // while the page stays open, only on entry - and never while the field
  // is actively focused, so it can't clobber an in-progress edit.
  //
  // Critical: this also POSTs the value, not just displays it. Update's
  // actual effect is decided entirely server-side - it reads the Reading
  // number entity's own current *device-side* state, not anything sent
  // from the press itself (buttons carry no payload). Only changing the
  // input's DOM value here left the two out of sync: the box could show
  // a fresh prefill while the device was still sitting on whatever was
  // last actually typed-and-blurred (or nothing, on first boot) - so
  // pressing Update without touching the field applied a stale, unrelated
  // old value instead of what was visibly on screen. Sending the same
  // value keeps what's shown and what Update would apply identical,
  // always.
  function prefillReadingFields() {
    for (const entity of entities.values()) {
      if (entity.domain !== "number" || !entity.inputEl || !comboBaseKey(entity.id)) continue;
      if (document.activeElement === entity.inputEl) continue;
      const source = totalConsumptionFor(entity.groupName);
      if (!source || typeof source.value !== "number" || Number.isNaN(source.value)) continue;
      const step = entity.step || 0.001;
      const snapped = Math.round(source.value / step) * step;
      const value = Math.round(snapped * 1000) / 1000;
      if (value === entity.value) continue; // already in sync, nothing to push
      entity.inputEl.value = value;
      entity.value = value;
      fetch(`${entity.namePath}/set?value=${encodeURIComponent(value)}`, { method: "POST" });
    }
  }

  function totalConsumptionFor(groupName) {
    for (const e of entities.values()) {
      if (e.groupName === groupName && displayName(e) === "Total Consumption") return e;
    }
    return null;
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
          <div id="dc-header-right">
            <div id="dc-wifi-signal" data-tier="0">
              <svg viewBox="0 0 20 16" aria-hidden="true">
                <rect class="bar bar-1" x="0" y="10" width="3" height="6" rx="1"/>
                <rect class="bar bar-2" x="5.5" y="7" width="3" height="9" rx="1"/>
                <rect class="bar bar-3" x="11" y="4" width="3" height="12" rx="1"/>
                <rect class="bar bar-4" x="16.5" y="1" width="3" height="15" rx="1"/>
              </svg>
            </div>
            <div id="dc-status"><span class="dot"></span><span class="label">Connecting…</span></div>
          </div>
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

  // On an abrupt device reboot (crash, power cycle, Restart button - any
  // path that isn't a clean TCP close) the browser's existing socket gets
  // no FIN/RST at all, just silence - nothing tells the EventSource
  // anything is wrong, so it never fires onerror and never auto-
  // reconnects, and #dc-status is left stuck showing "Connected" forever.
  // Confirmed reported behavior: reconnecting only ever happened after a
  // manual full page reload.
  //
  // The fix is a client-side activity watchdog, since the browser's own
  // error detection can't be relied on here: the server sends a "ping"
  // event every 10s to every connected client regardless of any other
  // traffic (confirmed from source, web_server.cpp's set_interval(10000,
  // ...) call) purely so a client can tell a live-but-quiet connection
  // apart from a dead one. lastActivityMs is touched on *any* inbound SSE
  // event (not just ping - state/log/sorting_group all count too, so a
  // burst of real activity doesn't need a ping in between to stay counted
  // as alive); if nothing arrives for ACTIVITY_TIMEOUT_MS (well over 2x
  // the ping interval, generous for normal network jitter), the
  // connection is declared dead unilaterally: close it and open a fresh
  // one, rather than waiting on onerror or the server's own `retry: 30000`
  // hint (too slow for something that might not fire at all).
  const ACTIVITY_TIMEOUT_MS = 25000;
  const WATCHDOG_INTERVAL_MS = 5000;
  const RECONNECT_DELAY_MS = 2000;
  let eventSource = null;
  let lastActivityMs = 0;
  let reconnectTimer = null;

  function touchActivity() {
    lastActivityMs = Date.now();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return; // already scheduled
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function connect() {
    if (eventSource) eventSource.close();
    const source = new EventSource("/events");
    eventSource = source;
    // Reset the clock the moment a fresh attempt starts, so the watchdog
    // doesn't immediately re-fire while this connection is still legitimately
    // in the process of opening.
    touchActivity();
    source.addEventListener("sorting_group", (ev) => {
      touchActivity();
      const data = JSON.parse(ev.data);
      setGroupWeight(data.name, data.sorting_weight);
    });
    // Both names are wired to the same handler: some ESPHome versions send
    // a one-time "state_detail_all" per entity before regular "state"
    // events, others (e.g. 2026.7.3, what this was actually tested
    // against) fold the full payload into the first "state" event
    // instead. handleStateEvent() figures out which kind it got.
    source.addEventListener("state_detail_all", (ev) => {
      touchActivity();
      handleStateEvent(JSON.parse(ev.data));
    });
    source.addEventListener("state", (ev) => {
      touchActivity();
      handleStateEvent(JSON.parse(ev.data));
    });
    // Raw logger output (web_server's default `log: true`) - plain text,
    // not JSON.
    source.addEventListener("log", (ev) => {
      touchActivity();
      appendLogLine(ev.data);
    });
    source.addEventListener("ping", () => {
      touchActivity();
      setConnected(true);
    });
    source.onopen = () => {
      touchActivity();
      setConnected(true);
    };
    source.onerror = () => {
      // A real, browser-detected error (e.g. connection actively refused
      // because the device is mid-reboot) - don't wait for the browser's
      // own retry (delayed by the server's `retry: 30000` hint); take over
      // and reconnect on our own faster schedule instead.
      setConnected(false);
      source.close();
      if (eventSource === source) eventSource = null;
      scheduleReconnect();
    };
  }

  function startConnectionWatchdog() {
    setInterval(() => {
      if (Date.now() - lastActivityMs > ACTIVITY_TIMEOUT_MS) {
        setConnected(false);
        scheduleReconnect();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  // Standalone/home-screen mode (WKWebView) leaves the bottom nav
  // untappable until the first scroll, even after dashboard.css stopped
  // wrapping everything in a position: fixed, never-itself-scrolling
  // shell (which fixed the white strip and the nav creeping up - real,
  // confirmed progress, just not the whole thing). What's left points at
  // a different, narrower cause: the <meta name=viewport> tag
  // (fixMobileMeta(), below) can only be inserted *after* the page has
  // already parsed - there's no way to get it into the server-sent HTML
  // itself - and WebKit is known to apply a late viewport change to
  // visual layout without necessarily re-syncing its internal touch
  // hit-testing to match, until something - a real scroll gesture -
  // forces that resync.
  //
  // nudgeViewportSync() tries to force that resync programmatically
  // instead of waiting for the user to stumble into it: a 1px scroll and
  // immediately back, right after the page is built.
  //
  // Confirmed load-bearing, not just unproven: removed for one round on
  // suspicion of causing an unrelated header/content overlap bug - that
  // bug turned out unaffected by it either way, but removing it brought
  // the dead-nav-until-scroll bug straight back (real-device confirmed),
  // so it is doing genuine work here even though the exact WebKit
  // mechanism it's compensating for is still not fully pinned down.
  function nudgeViewportSync() {
    const root = document.documentElement;
    const previousMinHeight = root.style.minHeight;
    root.style.minHeight = "calc(100vh + 10px)";
    window.scrollTo(0, 1);
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      root.style.minHeight = previousMinHeight;
    });
  }

  // Standalone-mode #dc-nav gap - still unsolved, see REQUIREMENTS.md/
  // commit history for the failed attempts and why. Real-device confirmed
  // WRONG (made it worse - clipped the nav under an opaque bar instead of
  // just leaving a gap above it): pushing #dc-nav down via a negative
  // `bottom` sized from window.screen.height - window.innerHeight. A
  // same-device comparison (another, unrelated site added to the Home
  // Screen) genuinely achieves true edge-to-edge rendering with no dead
  // zone at all, so this isn't an unreachable WebKit reservation as
  // first assumed - something about *this* page's setup, most likely the
  // lack of a real Web App Manifest (this project only sets the legacy
  // apple-mobile-web-app-* meta tags via fixMobileMeta() below, no
  // manifest.json/`display: standalone`) is the more likely next lead,
  // not yet attempted. Left alone (plain CSS bottom: 0) rather than
  // guessing a fourth time at real device cost.

  function start() {
    fixMobileMeta();
    currentPage = loadRememberedPage();
    buildShell();
    connect();
    startConnectionWatchdog();
    nudgeViewportSync();
    // Backstop for settleInitialBurst() - see its own comment. Normally
    // scheduleSettle()'s per-entity debounce (called from
    // handleFullPayload()) fires it sooner than this; this only matters
    // if entities somehow never stop trickling in.
    setTimeout(settleInitialBurst, SETTLE_MAX_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
