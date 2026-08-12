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
    "Show on Dashboard": "Shows or hides this meter's card on the Dashboard page. Purely a display preference - pulse counting and every other setting stay in effect either way.",
    "Display Name": "Shown instead of the fixed name above, on the Dashboard page and here.",
    "Mock Pressure (Test)": "Temporary stand-in for a real sensor reading, until Modbus polling is wired up - moving this publishes straight to this slot's Pressure reading.",
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

  function groupLabel(name) {
    return groupDisplayNames.get(name) || name;
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

  // "Show on Dashboard" only ever hides this meter's own Dashboard card -
  // its Service fields (Reading, Zero-Flow Timeout, Display Name, ...)
  // stay fully visible/editable regardless, since everything they control
  // stays in effect either way. Used to also collapse those down to just
  // the toggle itself (dc-meter-disabled/dc-field-keep-visible) - removed:
  // that made an already-configured meter harder to fix if it needed to
  // come back, for a purely cosmetic Dashboard-visibility preference.
  //
  // Pressure sensor slots don't go through this at all - their Home card
  // existence is gated by syncPressureHomeCard() below (never created
  // until commissioned, not created-then-hidden here) - see that
  // function's own comment for why.
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

  function upsertHomeMetric(entity) {
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
    entity.el.querySelector(".val").textContent = fmtValue(entity);
    entity.el.querySelector(".unit").textContent = entity.uom || "";
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
  // A dedicated, compact renderer for the 8 pressure sensor slots
  // (packages/pressure_sensor.yaml) - Name (editable) | Address (editable)
  // columns, one row per *commissioned* slot, growing/shrinking live as
  // slots are added/deleted. Entirely separate from the generic
  // per-sorting_group Service rendering above: every entity belonging to
  // a "Pressure Sensor N" slot group, or the umbrella "Pressure Sensors"
  // group (home of the Add name field/button), is intercepted in
  // render() before it ever reaches ensureServiceGroup()/ensureHomeGroup().
  //
  // "Commissioned or not" comes from each slot's own Commissioned
  // binary_sensor - a plain, always-live-updating VALUE, not an
  // existence/visibility trick. An earlier version of this tried hiding
  // the underlying entities themselves via ESPHome's `internal` flag,
  // toggled at runtime - reverted after finding that's explicitly
  // deprecated/undefined behavior in current ESPHome (confirmed from the
  // installed package's own esphome/core/entity_base.h). Every pressure
  // entity here always exists/is always sent to every client from the
  // first connection onward - only whether a *row* gets built from that
  // data is conditional, which is what actually avoids the old
  // create-then-hide flash (a card/row is now simply never created until
  // its slot's Commissioned value is known to be true, instead of being
  // created immediately and hidden a moment later).

  const PRESSURE_SLOT_RE = /^Pressure Sensor \d+$/;
  const PRESSURE_ADD_GROUP = "Pressure Sensors";

  function isPressureGroup(name) {
    return name === PRESSURE_ADD_GROUP || PRESSURE_SLOT_RE.test(name);
  }

  // undefined (not yet known - the value hasn't arrived over SSE yet) is
  // deliberately distinct from false (known, not commissioned) - callers
  // compare `=== true`, never just truthiness, so "unknown" is always
  // treated the same as "not commissioned" (never rendered) rather than
  // ever being mistaken for "commissioned".
  function pressureCommissioned(groupName) {
    for (const e of entities.values()) {
      if (e.groupName === groupName && e.domain === "binary_sensor" && displayName(e) === "Commissioned") {
        return e.value === true;
      }
    }
    return undefined;
  }

  function pressureSlotEntity(groupName, label) {
    for (const e of entities.values()) {
      if (e.groupName === groupName && displayName(e) === label) return e;
    }
    return null;
  }

  // Cross-slot duplicate check, purely against sensors already in *this*
  // list - not a real electrical bus collision check (that needs actually
  // talking Modbus over the real hardware, not available yet - see
  // REQUIREMENTS.md). Returns the display name of whichever other
  // commissioned slot already holds `address`, or null.
  function findPressureAddressOwner(address, excludeGroup) {
    for (const [groupName, row] of pressureRows) {
      if (groupName === excludeGroup) continue;
      const addr = pressureSlotEntity(groupName, "Modbus Address");
      if (addr && addr.value === address) return row._nameInput.value || groupName;
    }
    return null;
  }

  let pressureTableBody = null;

  // Registers the umbrella "Pressure Sensors" group as a normal
  // serviceGroups entry (reusing reorderServiceGroups()'s existing
  // weight-based interleaving with the meter/system sections, for free)
  // but with a bespoke body - a table instead of the generic .dc-fields
  // list - built once, on first use.
  function ensurePressureTable() {
    let g = serviceGroups.get(PRESSURE_ADD_GROUP);
    if (g) return pressureTableBody;
    const section = el("div", "dc-service-group dc-pressure-group");
    const label = el("div", "dc-section-label", "Pressure Sensors");
    const table = el(
      "table",
      "dc-pressure-table",
      `<thead><tr><th>Name</th><th>Address</th><th></th></tr></thead><tbody></tbody>`
    );
    const addRow = el("div", "dc-pressure-add-row");
    const addBtn = el("button", "dc-pressure-add-btn", "+");
    addBtn.type = "button";
    addRow.appendChild(addBtn);
    addBtn.addEventListener("click", () => showPressureAddForm(addRow, addBtn));
    section.append(label, table, addRow);
    g = { weight: groupWeights.get(PRESSURE_ADD_GROUP) ?? 500, section };
    serviceGroups.set(PRESSURE_ADD_GROUP, g);
    document.getElementById("dc-page-service").appendChild(section);
    reorderServiceGroups();
    pressureTableBody = table.querySelector("tbody");
    return pressureTableBody;
  }

  // Morphs the "+" button into a name input + confirm, backed by the
  // "Pressure Sensors New Sensor Name" text entity and "Pressure Sensors
  // Add" button (water-collector.yaml) - typing here alone changes
  // nothing on the device, same principle as the meters' own Reading
  // field, until Add is actually pressed.
  function showPressureAddForm(addRow, addBtn) {
    const nameEntity = entities.get("text-pressure_new_name");
    const addEntity = entities.get("button-pressure_add");
    if (!nameEntity || !addEntity) return; // not seen yet - shouldn't happen once connected, harmless no-op if it does
    addBtn.hidden = true;
    const form = el("div", "dc-pressure-add-form");
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 32;
    input.placeholder = "Sensor name";
    const confirmBtn = el("button", "dc-btn dc-btn-compact", "Add");
    confirmBtn.type = "button";
    form.append(input, confirmBtn);
    addRow.appendChild(form);
    input.focus();
    const cancel = () => {
      form.remove();
      addBtn.hidden = false;
    };
    confirmBtn.addEventListener("click", () => {
      fetch(`${nameEntity.namePath}/set?value=${encodeURIComponent(input.value)}`, { method: "POST" }).then(() =>
        fetch(`${addEntity.namePath}/press`, { method: "POST" })
      );
      cancel();
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") confirmBtn.click();
      else if (ev.key === "Escape") cancel();
    });
  }

  const pressureRows = new Map(); // groupName -> <tr> (with ._nameInput/._addrInput/._delBtn stashed on it)

  function syncPressureRow(groupName) {
    const tbody = ensurePressureTable();
    if (pressureCommissioned(groupName) !== true) {
      const row = pressureRows.get(groupName);
      if (row) {
        row.remove();
        pressureRows.delete(groupName);
      }
      return;
    }
    const nameEntity = pressureSlotEntity(groupName, "Display Name");
    const addrEntity = pressureSlotEntity(groupName, "Modbus Address");
    const delEntity = pressureSlotEntity(groupName, "Delete");
    let row = pressureRows.get(groupName);
    if (!row) {
      row = el(
        "tr",
        "",
        `<td class="dc-pressure-name"></td><td class="dc-pressure-addr"></td><td class="dc-pressure-del"></td>`
      );
      pressureRows.set(groupName, row);
      tbody.appendChild(row);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 32;
      row.querySelector(".dc-pressure-name").appendChild(nameInput);
      nameInput.addEventListener("change", () => {
        const e = pressureSlotEntity(groupName, "Display Name");
        if (e) fetch(`${e.namePath}/set?value=${encodeURIComponent(nameInput.value)}`, { method: "POST" });
      });
      row._nameInput = nameInput;

      const addrInput = document.createElement("input");
      addrInput.type = "number";
      addrInput.min = 0;
      addrInput.max = 247;
      addrInput.step = 1;
      row.querySelector(".dc-pressure-addr").appendChild(addrInput);
      addrInput.addEventListener("change", () => {
        const e = pressureSlotEntity(groupName, "Modbus Address");
        if (!e) return;
        const parsed = parseInt(addrInput.value, 10);
        if (Number.isNaN(parsed) || parsed < 0 || parsed > 247) {
          addrInput.value = e.value ?? "";
          return;
        }
        if (parsed > 0) {
          const dupe = findPressureAddressOwner(parsed, groupName);
          if (
            dupe &&
            !confirm(
              `Address ${parsed} is already used by "${dupe}" in this list. This only checks sensors already commissioned here, not the physical bus - set it anyway?`
            )
          ) {
            addrInput.value = e.value ?? "";
            return;
          }
        }
        fetch(`${e.namePath}/set?value=${encodeURIComponent(parsed)}`, { method: "POST" });
      });
      row._addrInput = addrInput;

      const delBtn = el("button", "dc-pressure-del-btn", "✕");
      delBtn.type = "button";
      row.querySelector(".dc-pressure-del").appendChild(delBtn);
      row._delBtn = delBtn;
    }
    if (nameEntity) {
      row._delBtn.onclick = () => pressButton(delEntity);
      if (document.activeElement !== row._nameInput) row._nameInput.value = nameEntity.value ?? "";
      // Mirrors what upsertServiceText() does for the water meters (CR
      // #8) - this slot's Home card header/icon uses the same shared
      // groupLabel()/refreshGroupLabel() machinery, which otherwise has
      // no other way to learn this group's renamed Display Name, since
      // pressure entities never reach upsertServiceText() at all.
      groupDisplayNames.set(groupName, (nameEntity.value || "").trim());
      applyGroupLabel(groupName);
    }
    if (addrEntity && document.activeElement !== row._addrInput) {
      row._addrInput.value = addrEntity.value || "";
    }
  }

  // Home card existence, gated purely on Commissioned - see this
  // section's own header comment for why this (not create-then-hide)
  // is what actually avoids a flash. Reuses upsertHomeMetric()/
  // ensureHomeGroup() as-is once commissioned; on the way back to
  // uncommissioned (Delete), removes the card outright rather than just
  // hiding it - a deleted slot has genuinely nothing left to show.
  function syncPressureHomeCard(groupName) {
    if (pressureCommissioned(groupName) !== true) {
      const home = homeGroups.get(groupName);
      if (home) {
        home.card.remove();
        homeGroups.delete(groupName);
      }
      return;
    }
    const pressureEntity = pressureSlotEntity(groupName, "Pressure");
    if (pressureEntity) upsertHomeMetric(pressureEntity);
  }

  function renderPressureEntity(entity) {
    if (entity.groupName === PRESSURE_ADD_GROUP) {
      ensurePressureTable(); // make sure the table + "+" row exist even with zero slots commissioned yet
      return;
    }
    syncPressureRow(entity.groupName);
    syncPressureHomeCard(entity.groupName);
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

  // Show on Dashboard (CR #9) - a pill toggle. Purely a dashboard
  // visibility preference (see the YAML comment next to it) - flipping it
  // shows/hides this meter's Dashboard card, nothing else; its other
  // Service fields stay visible/editable regardless (see the note on
  // applyGroupVisibility() for why that changed).
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
    if (label === "Show on Dashboard") {
      groupEnabled.set(entity.groupName, on);
      applyGroupVisibility(entity.groupName);
    }
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
    if (label === "Delete") {
      return `Delete ${entity.groupName}'s commissioning (Modbus Address, Display Name)? Its Dashboard card disappears until re-commissioned.`;
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
    // the "Pressure sensor table" section above for why. Two exceptions
    // still ALSO fall through below, unlike every other pressure entity:
    //  - Commissioned itself (entity_category: diagnostic routes it to
    //    the Diagnostics page as a plain row too - harmless, useful for
    //    debugging).
    //  - Mock Pressure (Test), the temporary stand-in for a real Modbus
    //    read (packages/pressure_sensor.yaml) - the compact table only
    //    has Name/Address/Delete columns, nowhere to put this, so it
    //    falls through to a normal (generic, one-off) Service field
    //    instead, same as before this table existed. Delete this
    //    exception together with the rest of the Mock Pressure scaffold
    //    once real Modbus polling replaces it.
    if (entity.groupName && isPressureGroup(entity.groupName)) {
      renderPressureEntity(entity);
      const label = displayName(entity);
      const passThrough = (entity.domain === "binary_sensor" && label === "Commissioned") || label === "Mock Pressure (Test)";
      if (!passThrough) return;
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
