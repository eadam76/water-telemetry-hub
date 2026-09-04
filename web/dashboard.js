
(function () {
  "use strict";

  const ENTITY_CATEGORY_DIAGNOSTIC = 2;
  const NUMBER_MODE_SLIDER = 2;
  const FALLBACK_GROUP = "Other";

  const HELP_TEXT = {
    "Total Consumption": "Cumulative water use - read directly from the meter's own accumulated total (Modbus flow meters), or calculated from the pulse count and the last calibration (pulse meters). Either way, not a live meter photograph.",
    "Calculated Flow Rate": "Instantaneous flow, based on the time between the last two pulses. Drops to 0 automatically after Zero-Flow Timeout with no new pulses.",
    "Reading": "Enter the physical meter's current reading here, then press Update to apply it. Typing here alone changes nothing - and Update itself only corrects the total shown on this dashboard, it never writes anything to the meter.",
    "Update": "Applies the Reading above as a software-side correction to Total Consumption - the physical meter's own accumulated total is never modified. See Correction Offset for how much is currently being added or subtracted, and Reset Correction to remove it.",
    "Correction Offset": "The amount currently being added to (or, if negative, subtracted from) the meter's own raw reading to produce Total Consumption - 0 means nothing is being corrected. Set by the last Update press; Reset Correction below clears it back to 0.",
    "Reset Correction": "Clears the correction above back to 0, so Total Consumption goes back to showing exactly the meter's own raw reading. Only undoes a past Update - the meter itself was never touched either way.",
    "Battery Voltage": "The flow meter's own internal battery voltage, as reported by the meter itself - nominally around 3.6 V when fresh. A low reading may mean it's due for replacement.",
    "Zero-Flow Timeout": "How long with no pulses before Calculated Flow Rate is shown as 0. Lower reacts faster; higher tolerates slow trickles without a false zero.",
    "Display Name": "Shown instead of the fixed name above, on the Dashboard page and here.",
    "Flow Rate": "Live instantaneous flow rate, read directly from the Modbus flow meter - not derived from pulse timing the way the pulse meters' own Calculated Flow Rate is.",
  };

  // Buttons/fields whose action isn't easily undone get an explicit
  // confirmation before firing - matched by displayName(), so it
  // applies uniformly across meters without hardcoding names.
  // "Update" is deliberately NOT here any more: applying a Reading is no
  // longer a button press at all, it's a single value-carrying write with
  // its own confirmation (see applyTypedReading()).
  const CONFIRM_ON_PRESS = new Set(["Reset Correction", "Reboot Device", "Forget Wi-Fi", "Delete"]);
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
    flow: '<path d="M3 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M3 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M3 20c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>',
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
    "Pulse Meter 1": "water",
    "Pulse Meter 2": "water",
    "Network": "wifi",
    "System": "cog",
  };
  function groupIcon(name) {
    if (GROUP_ICON_BY_NAME[name]) return GROUP_ICON_BY_NAME[name];
    if (PRESSURE_SLOT_RE.test(name)) {
      const typeEntity = pressureSlotEntity(name, "Device Type");
      if (!typeEntity || typeEntity.value === undefined) return "dot";
      return typeEntity.value === "Flow" ? "flow" : "gauge";
    }
    return "dot";
  }
  const PAGES = [
    { id: "home", label: "Dashboard", icon: "water" },
    { id: "service", label: "Devices", icon: "wrench" },
    { id: "diagnostics", label: "System", icon: "list" },
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
  // sorting_group name -> its "Show on Dashboard" switch's current
  // state. Missing entry == not yet known/no such switch -> treated as
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
    const custom = groupDisplayNames.get(name);
    if (custom) return custom;
    return isPressureGroup(name) ? "" : name;
  }

  // Re-applies a group's current display name to every page that has
  // already built a container for it - called both when the name itself
  // changes and (from ensure*Group()) when a container is created after
  // the name was already known, so arrival order never matters.
  // settleInitialBurst() below calls this for every known group name,
  // including "Devices" (DEVICE_TABLE_GROUP) - whose own section (built
  // by ensureDeviceTable(), not ensureServiceGroup()) deliberately has
  // no .hub-section-label at all, unlike every group
  // ensureServiceGroup() itself builds. That made
  // `.querySelector(...).textContent = label` throw on a null result -
  // uncaught, since this runs from a setTimeout callback - which
  // silently aborted whatever *else* settleInitialBurst() still had left
  // to do for any group ordered after "Devices" in its own Set
  // (undefined, SSE-arrival-order-dependent iteration order). Querying
  // first and guarding on the result, same as `home`/`svc`/`diag`
  // themselves already are, fixes this properly rather than special-
  // casing "Devices" by name.
  function refreshGroupLabel(name) {
    const label = groupLabel(name);
    const home = homeGroups.get(name);
    const homeLabelEl = home && home.card.querySelector(".hub-meter-card-header-label");
    if (homeLabelEl) homeLabelEl.textContent = label;
    const svc = serviceGroups.get(name);
    const svcLabelEl = svc && svc.section.querySelector(".hub-section-label");
    if (svcLabelEl) svcLabelEl.textContent = label;
    const diag = diagGroups.get(name);
    const diagLabelEl = diag && diag.section.querySelector(".hub-section-label");
    if (diagLabelEl) diagLabelEl.textContent = label;
  }

  const SETTLE_QUIET_MS = 800;
  const SETTLE_MAX_MS = 6000;
  let initialSettled = false;
  let settleQuietTimer = null;

  let scanResultsFresh = false;

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

  function applyGroupVisibility(name) {
    if (!initialSettled) return;
    const enabled = groupEnabled.get(name) !== false;
    const home = homeGroups.get(name);
    if (home) home.card.classList.toggle("hub-hidden", !enabled);
  }

  // --- Home page: one card per meter's sorting_group ------------------

  const homeGroups = new Map(); // groupName -> { weight, card, body }

  function ensureHomeGroup(name) {
    let g = homeGroups.get(name);
    if (g) return g;
    const card = el("div", "hub-meter-card");
    const header = el("div", "hub-meter-card-header");
    // Icon lives in its own element (not just a raw svgIcon() string
    // baked into the header's innerHTML at creation time) so it can be
    // refreshed later - see refreshGroupIcon() below. Only matters for
    // pressure slots today (groupIcon() depends on that slot's own,
    // async-arriving Device Type entity - every other group's icon is a
    // static lookup that never changes after creation), but keeping this
    // generic costs nothing.
    const iconEl = el("span", "hub-meter-card-header-icon", svgIcon(groupIcon(name)));
    const labelEl = el("span", "hub-meter-card-header-label", groupLabel(name));
    const statusEl = el("span", "hub-pressure-badge hub-meter-card-status", "");
    header.append(iconEl, labelEl, statusEl);
    const body = el("div", "hub-meter-card-body");
    card.append(header, body);
    // metrics: one row per measurement, keyed by its label - see
    // upsertHomeMetric() for why a row can hold more than one entity.
    g = { weight: groupWeights.get(name) ?? 500, card, body, iconEl, statusEl, metrics: new Map() };
    homeGroups.set(name, g);
    document.getElementById("hub-page-home").appendChild(card);
    reorderHomeGroups();
    applyGroupVisibility(name); // no-op until the initial SSE burst settles - see settleInitialBurst()
    return g;
  }

  function refreshGroupIcon(name) {
    const home = homeGroups.get(name);
    if (home) home.iconEl.innerHTML = svgIcon(groupIcon(name));
  }

  const PRESSURE_BADGE_CLASSES = [
    "hub-pressure-badge-ok",
    "hub-pressure-badge-lost",
    "hub-pressure-badge-collision",
    "hub-pressure-badge-mismatch",
    "hub-pressure-badge-pending",
  ];
  function pressureStatusState(online, hasCollision, hasMismatch) {
    if (hasCollision) return { text: "Collision", cssClass: "hub-pressure-badge-collision" };
    if (hasMismatch) return { text: "Mismatch", cssClass: "hub-pressure-badge-mismatch" };
    if (online === undefined) return { text: "Checking…", cssClass: "hub-pressure-badge-pending" };
    return online ? { text: "OK", cssClass: "hub-pressure-badge-ok" } : { text: "Lost", cssClass: "hub-pressure-badge-lost" };
  }

  function updateHomeCardStatus(groupName, text, cssClass) {
    const home = homeGroups.get(groupName);
    if (!home || !home.statusEl) return;
    home.statusEl.textContent = text;
    for (const c of PRESSURE_BADGE_CLASSES) home.statusEl.classList.toggle(c, c === cssClass);
  }

  function reorderHomeGroups() {
    const container = document.getElementById("hub-page-home");
    for (const g of [...homeGroups.values()].sort((a, b) => a.weight - b.weight)) {
      container.appendChild(g.card);
    }
  }

  // The entity's label with a trailing unit-in-parentheses removed, but
  // only when it is exactly the unit already being displayed - so a name
  // that genuinely contains a parenthetical for some other reason is
  // left alone.
  function metricLabel(entity) {
    const label = displayName(entity);
    const uom = entity.uom;
    if (!uom) return label;
    const suffix = ` (${uom})`;
    return label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
  }

  // Left-to-right order for the units of one measurement shown side by
  // side, so every meter's card reads the same way round regardless of
  // which unit that meter measures in natively. Anything unlisted sorts
  // after, in arrival order.
  const UNIT_ORDER = ["m³", "bar", "m³/h", "L/min"];

  function unitRank(uom) {
    const index = UNIT_ORDER.indexOf(uom || "");
    return index === -1 ? UNIT_ORDER.length : index;
  }

  // One row per measurement, not per entity. A flow rate is published as
  // two entities - the same measurement in m³/h and in l/min, so nothing
  // downstream has to convert - and rendering them as two separate rows
  // repeated the label under each of them for no reason. They share a
  // row and a label, and the values sit side by side in a fixed order.
  function upsertHomeMetric(entity, forceUnavailable) {
    const group = ensureHomeGroup(entity.groupName ?? FALLBACK_GROUP);
    const label = metricLabel(entity);
    let metric = group.metrics.get(label);
    if (!metric || !metric.isConnected) {
      metric = el("div", "hub-metric", `<div class="v"></div><div class="l"><span class="label-text"></span></div>`);
      metric._cells = new Map();
      metric.querySelector(".label-text").textContent = label;
      attachHelp(metric.querySelector(".l"), HELP_TEXT[label]);
      group.metrics.set(label, metric);
      group.body.appendChild(metric);
    }
    entity.el = metric;

    const values = metric.querySelector(".v");
    let cell = metric._cells.get(entity.id);
    if (!cell || !cell.isConnected) {
      cell = el("span", "hub-metric-value", `<span class="val"></span><span class="unit"></span>`);
      metric._cells.set(entity.id, cell);
      values.appendChild(cell);
    }
    cell.dataset.rank = unitRank(entity.uom);
    cell.querySelector(".val").textContent = forceUnavailable ? "--" : fmtValue(entity);
    // The unit is shown exactly as the entity carries it - the same
    // spelling Home Assistant sees, so the two never disagree about what
    // a number is measured in.
    cell.querySelector(".unit").textContent = forceUnavailable ? "" : entity.uom || "";
    for (const c of [...values.children].sort((a, b) => (+a.dataset.rank) - (+b.dataset.rank))) {
      values.appendChild(c);
    }

    // A shared row sits where its earliest-sorting member would.
    const own = entity.groupWeight ?? 500;
    const current = metric.dataset.weight === undefined ? Infinity : +metric.dataset.weight;
    metric.dataset.weight = Math.min(current, own);
    // The lowest-weight metric in the card is the headline (big) number -
    // Total Consumption, by sorting_weight, see packages/water_meter.yaml.
    const rows = [...group.body.children].sort((a, b) => (+a.dataset.weight) - (+b.dataset.weight));
    rows.forEach((r, i) => {
      r.classList.toggle("hub-metric-headline", i === 0);
      group.body.appendChild(r);
    });
  }

  const diagGroups = new Map(); // groupName -> { weight, section, list, actions }

  function ensureDiagGroup(name) {
    let g = diagGroups.get(name);
    if (g) return g;
    const section = el("div", "hub-diag-group");
    const label = el("div", "hub-section-label", groupLabel(name));
    const list = el("div", "hub-list");
    const actions = el("div", "hub-diag-actions");
    section.append(label, list, actions);
    g = { weight: groupWeights.get(name) ?? 500, section, list, actions };
    diagGroups.set(name, g);
    document.getElementById("hub-page-diagnostics").appendChild(section);
    reorderDiagGroups();
    return g;
  }

  function reorderDiagGroups() {
    const container = document.getElementById("hub-page-diagnostics");
    for (const g of [...diagGroups.values()].sort((a, b) => a.weight - b.weight)) {
      container.appendChild(g.section);
    }
  }

  function upsertDiagRow(entity) {
    const group = ensureDiagGroup(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.el) {
      entity.el = el("div", "hub-list-row", `<span class="k"></span><span class="v"></span>`);
      group.list.appendChild(entity.el);
    }
    entity.el.dataset.weight = entity.groupWeight ?? 500;
    entity.el.querySelector(".k").textContent = displayName(entity);
    entity.el.querySelector(".v").textContent = fmtValue(entity) + (entity.uom ? " " + entity.uom : "");
    for (const r of [...group.list.children].sort((a, b) => (+a.dataset.weight) - (+b.dataset.weight))) {
      group.list.appendChild(r);
    }
  }

  function reorderDiagActions(group) {
    for (const r of [...group.actions.children].sort((a, b) => (+a.dataset.weight) - (+b.dataset.weight))) {
      group.actions.appendChild(r);
    }
  }

  // reorderServiceFields() (defined further down, in the Devices-page
  // section) is already fully generic - it only ever touches
  // `group.fields`, never anything Devices-page-specific - so this reuses
  // it verbatim rather than maintaining a duplicate copy for the System
  // page's own `fields` (the proper .hub-field-card area, not the
  // compact-button .hub-diag-actions row above).
  const reorderDiagFields = (group) => reorderServiceFields(group);

  function upsertDiagButton(entity) {
    const group = ensureDiagGroup(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.btnEl) {
      entity.btnEl = el("button", "hub-btn hub-btn-compact", entity.name);
      entity.btnEl.type = "button";
      entity.btnEl.addEventListener("click", () => pressButton(entity));
      group.actions.appendChild(entity.btnEl);
    }
    entity.btnEl.dataset.weight = entity.groupWeight ?? 500;
    reorderDiagActions(group);
  }

  // --- Service page: calibration fields + device action buttons --------

  const serviceGroups = new Map(); // groupName -> { weight, section, fields }

  function ensureServiceGroup(name) {
    let g = serviceGroups.get(name);
    if (g) return g;
    const section = el("div", "hub-service-group");
    const label = el("div", "hub-section-label", groupLabel(name));
    const fields = el("div", "hub-fields");
    section.append(label, fields);
    g = { weight: groupWeights.get(name) ?? 500, section, fields };
    serviceGroups.set(name, g);
    document.getElementById("hub-page-service").appendChild(section);
    reorderServiceGroups();
    applyGroupVisibility(name); // no-op until the initial SSE burst settles - see settleInitialBurst()
    return g;
  }

  function reorderServiceGroups() {
    const container = document.getElementById("hub-page-service");
    for (const g of [...serviceGroups.values()].sort((a, b) => a.weight - b.weight)) {
      container.appendChild(g.section);
    }
  }

  function reorderServiceFields(group) {
    const sorted = [...group.fields.children].sort((a, b) => (+a.dataset.weight) - (+b.dataset.weight));
    let alreadyOrdered = true;
    for (let i = 0; i < sorted.length; i++) {
      if (group.fields.children[i] !== sorted[i]) {
        alreadyOrdered = false;
        break;
      }
    }
    if (alreadyOrdered) return;
    for (const r of sorted) group.fields.appendChild(r);
  }


  const PRESSURE_SLOT_RE = /^Modbus Device \d+$/;
  const PRESSURE_ADD_GROUP = "Modbus Devices";
  // Must match how many pressure_slotN packages water-telemetry-hub.yaml
  // actually instantiates. Only used to grey out the
  // Add control once every slot is taken; the slots themselves are
  // discovered from the entities that actually arrive, so this constant
  // going stale can never invent a slot that isn't there - it would only
  // mis-report the ceiling.
  const PRESSURE_MAX_SLOTS = 4;
  const TYPE_READING_HINT = {
    "": "Choose a device type to see what it'll add",
    Pressure: "→ Pressure, bar",
    Flow: "→ Total Consumption, m³ + Flow Rate, m³/h",
  };
  // Real firmware sorting_group name (water-telemetry-hub.yaml's
  // sorting_group_pulse_meters) - kept purely for its own sorting_weight
  // (used below to position the unified "Devices" table), same as
  // PRESSURE_ADD_GROUP's weight is used for the same purpose. No entity
  // is tagged directly to it (see that group's own comment in
  // water-telemetry-hub.yaml).
  const PULSE_METER_ANCHOR_GROUP = "Pulse Meters";

  function isPressureGroup(name) {
    return name === PRESSURE_ADD_GROUP || PRESSURE_SLOT_RE.test(name);
  }

  function pressureSlotEntity(groupName, label) {
    for (const e of entities.values()) {
      if (e.groupName === groupName && displayName(e) === label) return e;
    }
    return null;
  }

  function registeredPressureSlots() {
    const slots = [];
    for (const e of entities.values()) {
      if (e.groupName && PRESSURE_SLOT_RE.test(e.groupName) && e.domain === "number" && displayName(e) === "Modbus Address") {
        const address = Math.round(e.value || 0);
        if (address > 0) {
          const onlineEntity = pressureSlotEntity(e.groupName, "Online");
          const orderEntity = pressureSlotEntity(e.groupName, "Sort Order");
          const typeEntity = pressureSlotEntity(e.groupName, "Device Type");
          slots.push({
            groupName: e.groupName,
            address,
            online: onlineEntity && onlineEntity.value !== undefined ? onlineEntity.value === true : undefined,
            order: orderEntity ? Math.round(orderEntity.value || 0) : 0,
            deviceType: typeEntity ? typeEntity.value : undefined,
          });
        }
      }
    }
    return slots;
  }

  function registeredPulseMeterSlots() {
    const slots = [];
    for (const groupName of pulseMeterGroups()) {
      if (!isPulseMeterRegistered(groupName)) continue;
      const orderEntity = pulseMeterSlotEntity(groupName, "Sort Order");
      slots.push({ groupName, order: orderEntity ? Math.round(orderEntity.value || 0) : 0 });
    }
    return slots;
  }

  function orderedRegisteredDevices() {
    const list = [
      ...registeredPressureSlots().map((s) => ({ type: "pressure", groupName: s.groupName, order: s.order, address: s.address, online: s.online, deviceType: s.deviceType })),
      ...registeredPulseMeterSlots().map((s) => ({ type: "pulse", groupName: s.groupName, order: s.order })),
    ];
    return list.sort((a, b) => {
      if (a.order && b.order) return a.order - b.order;
      if (a.order) return -1;
      if (b.order) return 1;
      return a.groupName < b.groupName ? -1 : a.groupName > b.groupName ? 1 : 0;
    });
  }

  // Moves `groupName` (either device type) one step up/down (direction
  // -1/+1) in the current UNIFIED display order and persists the result
  // by rewriting *every* registered device's own Sort Order (whichever
  // type it is) to match the new sequence (1, 2, 3, ...) - not just the
  // two rows that swapped. Same reasoning as the pre-unification,
  // pressure-only movePressureRow() this replaces: simpler and
  // self-healing than a narrower two-row update, can never leave a stale
  // or duplicate rank behind regardless of prior state, at the cost of a
  // handful of extra requests for a rare, deliberate user action.
  function moveDeviceRow(groupName, direction) {
    const ordered = orderedRegisteredDevices();
    const idx = ordered.findIndex((d) => d.groupName === groupName);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= ordered.length) return;
    const devices = [...ordered];
    [devices[idx], devices[swapIdx]] = [devices[swapIdx], devices[idx]];
    devices.forEach((d, i) => {
      const e = d.type === "pressure" ? pressureSlotEntity(d.groupName, "Sort Order") : pulseMeterSlotEntity(d.groupName, "Sort Order");
      if (e) postRequest(`${e.namePath}/set?value=${i + 1}`).catch((error) => showRequestError(error, "Device reorder failed"));
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

  // Addresses the scan's shared AddressInspector (see
  // include/rs485_modbus.h) resolved to PROVEN_COLLISION - never a single
  // damaged frame taken at face value, but repeated/correlated activity
  // (a re-probe, a damaged fingerprint, or a live measurement read that
  // never settles) that a lone device could not produce. Real, if not
  // airtight: two bit-identical devices answering in perfect lockstep are
  // protocol-indistinguishable from one and cannot be proven this way.
  // Distinct from both a clean find and plain silence. An address is
  // never in both this and latestScanAddresses()
  // at once - each address gets exactly one outcome per scan.
  function latestCollisionAddresses() {
    const e = pressureSlotEntity(PRESSURE_ADD_GROUP, "Scan Collisions");
    if (!e || typeof e.value !== "string" || !e.value.trim()) return [];
    return e.value
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 247);
  }

  function latestMismatchAddresses() {
    const e = pressureSlotEntity(PRESSURE_ADD_GROUP, "Scan Mismatches");
    if (!e || typeof e.value !== "string" || !e.value.trim()) return [];
    return e.value
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 247);
  }

  // The device's verdict on the last Add press ("ok", or why it refused).
  // Same reasoning as the Reading update's own result channel: the POSTs
  // returning 200 only means the request arrived, and an Add that the
  // firmware then refuses used to show up as the New row simply never
  // turning into a registered one, with no reason anywhere.
  const addResultWaiters = new Set();

  function notifyAddResult(entity) {
    const status = typeof entity.value === "string" ? entity.value.trim() : "";
    if (!status) return;
    for (const waiter of [...addResultWaiters]) waiter(status);
  }

  function watchAddResult() {
    let settle = null;
    let timer = null;
    const finish = (status) => {
      if (!settle) return;
      addResultWaiters.delete(listener);
      clearTimeout(timer);
      const resolve = settle;
      settle = null;
      resolve(status);
    };
    const listener = (status) => finish(status);
    const promise = new Promise((resolve) => {
      settle = resolve;
      addResultWaiters.add(listener);
      // Unknown rather than failure if nothing comes back - the table
      // itself will show whether the device registered.
      timer = setTimeout(() => finish(null), 4000);
    });
    return { promise, cancel: () => finish(null) };
  }

  // What the last scan decided each answering device actually is, as
  // address -> "Pressure"/"Flow". Parsed from "<address>:<type>" pairs
  // (water-telemetry-hub.yaml's Scan Device Types) - addresses the firmware
  // could not identify are simply absent, and stay the person's call.
  function latestScanTypes() {
    const types = new Map();
    const e = pressureSlotEntity(PRESSURE_ADD_GROUP, "Scan Device Types");
    if (!e || typeof e.value !== "string" || !e.value.trim()) return types;
    for (const pair of e.value.split(",")) {
      const [rawAddress, rawType] = pair.split(":");
      const address = parseInt((rawAddress || "").trim(), 10);
      const type = (rawType || "").trim();
      if (!Number.isInteger(address) || address <= 0 || address > 247) continue;
      if (type === "Pressure" || type === "Flow") types.set(address, type);
    }
    return types;
  }

  function findPressureAddressOwner(address, excludeGroup) {
    for (const slot of registeredPressureSlots()) {
      if (slot.groupName === excludeGroup || slot.address !== address) continue;
      const nameEntity = pressureSlotEntity(slot.groupName, "Display Name");
      return (nameEntity && nameEntity.value) || slot.groupName;
    }
    return null;
  }

  let deviceTableBody = null;
  let deviceToolbarEl = null;
  const DEVICE_TABLE_GROUP = "Devices";

  function ensureDeviceTable() {
    let g = serviceGroups.get(DEVICE_TABLE_GROUP);
    if (g) return deviceTableBody;
    const section = el("div", "hub-service-group hub-pressure-group");
    const toolbar = el("div", "hub-pressure-toolbar");
    const table = el(
      "table",
      "hub-pressure-table",
      `<thead><tr><th>Name</th><th>Status</th><th></th><th></th></tr></thead><tbody></tbody>`
    );
    // A future extra column has to go somewhere; scrolling the table
    // itself horizontally, on whichever screen is too narrow for it,
    // beats squeezing every column down or clipping content outright
    // (#hub-main forces overflow-x: hidden page-wide - see its own
    // comment).
    const tableScroll = el("div", "hub-pressure-table-scroll");
    tableScroll.appendChild(table);
    const card = el("div", "hub-devices-card");
    card.append(tableScroll, toolbar);
    section.append(card);
    g = { weight: groupWeights.get(PULSE_METER_ANCHOR_GROUP) ?? groupWeights.get(PRESSURE_ADD_GROUP) ?? 500, section };
    serviceGroups.set(DEVICE_TABLE_GROUP, g);
    document.getElementById("hub-page-service").appendChild(section);
    reorderServiceGroups();
    deviceTableBody = table.querySelector("tbody");
    deviceToolbarEl = toolbar;
    mountDeviceAddButtons();
    return deviceTableBody;
  }

  let addPulseBtn = null;
  function mountDeviceAddButtons() {
    if (addPulseBtn) return;
    addPulseBtn = el("button", "hub-btn hub-btn-compact", "Add Pulse Meter");
    addPulseBtn.type = "button";
    addPulseBtn.addEventListener("click", () => toggleDeviceAdd());
    deviceToolbarEl.append(addPulseBtn);
  }

  function toggleDeviceAdd() {
    if (deviceEditingRow && deviceEditingRow._cancelEdit) deviceEditingRow._cancelEdit();
    deviceAddOpen = !deviceAddOpen;
    renderDeviceTableBody();
    if (deviceAddOpen && deviceAddRow && deviceAddRow._nameInput) deviceAddRow._nameInput.focus();
  }

  // Disables the Add button once there's nothing left to add (both GPIO
  // slots already registered) - called once per renderDeviceTableBody()
  // render, a cheap no-op update most of the time.
  function refreshDeviceAddButtons() {
    if (!addPulseBtn) return;
    const freePulseSlots = pulseMeterGroups().filter((g) => !isPulseMeterRegistered(g));
    addPulseBtn.disabled = freePulseSlots.length === 0;
    addPulseBtn.title = freePulseSlots.length === 0 ? "Both pulse meter slots are already registered." : "";
  }

  function mountPressureToolbarButton(entity) {
    if (!entity.btnEl) {
      entity.idleLabel = displayName(entity);
      entity.btnEl = el("button", "hub-btn hub-btn-compact", entity.idleLabel);
      entity.btnEl.addEventListener("click", () => {
        if (entity.btnEl.disabled) return;
        // A fresh, deliberate scan supersedes any earlier session-local
        // dismissal (dismissDeviceAddRow.../dismissedScanAddresses below)
        // - the user explicitly asked to see the bus's current state
        // again, not whatever was previously waved away.
        dismissedScanAddresses.clear();
        postRequest(`${entity.namePath}/press`).catch((error) => showRequestError(error, "Device scan failed"));
      });
      entity.statusEl = el("span", "hub-pressure-scan-status", `<span class="hub-spinner"></span><span>Scanning…</span>`);
      entity.statusEl.hidden = true;
      // Plain append - always lands after the Add buttons (see
      // mountDeviceAddButtons()'s own comment for why that's guaranteed
      // regardless of arrival-order timing).
      deviceToolbarEl.append(entity.btnEl, entity.statusEl);
    }
  }

  // Drives the Scan Bus button's busy state from modbus_scan_in_progress
  // (see mountPressureToolbarButton()'s own comment for why this - not
  // the button entity's own fetch() - is the source of truth). A ~6s
  // scan with only a disabled button as feedback still read as "did this
  // actually do anything?" at a glance - the adjacent spinner+label is a
  // second, more immediately legible "something is happening" signal.
  function syncScanButtonBusyState(inProgress) {
    const scanEntity = pressureSlotEntity(PRESSURE_ADD_GROUP, "Find Modbus Devices");
    if (!scanEntity || !scanEntity.btnEl) return;
    scanEntity.btnEl.disabled = inProgress;
    scanEntity.statusEl.hidden = !inProgress;
  }

  const deviceTableRows = new Map();
  const pressureNewRowDrafts = new Map(); // address -> in-progress typed name, kept across re-renders until Add/rescan
  let deviceEditingRow = null;

  function upsertRegisteredPressureRow(tbody, groupName, online, hasCollision, hasMismatch, isFirst, isLast, deviceType) {
    const key = "reg:" + groupName;
    const nameEntity = pressureSlotEntity(groupName, "Display Name");
    const addrEntity = pressureSlotEntity(groupName, "Modbus Address");
    const delEntity = pressureSlotEntity(groupName, "Delete");
    let row = deviceTableRows.get(key);
    if (!row) {
      row = el(
        "tr",
        "hub-pressure-row-registered",
        `<td class="hub-pressure-name"></td><td class="hub-pressure-status"></td><td class="hub-pressure-action"></td><td class="hub-pressure-order"></td>`
      );
      deviceTableRows.set(key, row);
      tbody.appendChild(row);

      const nameCell = row.querySelector(".hub-pressure-name");
      const nameRow = el("div", "hub-pressure-name-row");
      nameCell.appendChild(nameRow);
      const typeIcon = el("span", "hub-device-type-icon", svgIcon("gauge"));
      nameRow.appendChild(typeIcon);
      row._typeIconEl = typeIcon;
      const nameContent = el("div", "hub-pressure-name-content");
      nameRow.appendChild(nameContent);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 32;
      nameInput.disabled = true;
      nameContent.appendChild(nameInput);
      row._nameInput = nameInput;

      const status = el("span", "hub-pressure-badge");
      row.querySelector(".hub-pressure-status").appendChild(status);
      row._statusEl = status;

      const actionCell = row.querySelector(".hub-pressure-action");

      const editBtn = el("button", "hub-pressure-icon-btn hub-pressure-edit-btn", svgIcon("pencil"));
      editBtn.type = "button";
      editBtn.title = "Edit name/address";
      actionCell.appendChild(editBtn);
      row._editBtn = editBtn;

      const delBtn = el("button", "hub-pressure-icon-btn hub-pressure-del-btn", svgIcon("trash"));
      delBtn.type = "button";
      delBtn.title = "Delete";
      actionCell.appendChild(delBtn);
      row._delBtn = delBtn;

      const saveBtn = el("button", "hub-pressure-icon-btn hub-pressure-save-btn", svgIcon("check"));
      saveBtn.type = "button";
      saveBtn.title = "Save";
      actionCell.appendChild(saveBtn);
      row._saveBtn = saveBtn;

      const cancelBtn = el("button", "hub-pressure-icon-btn hub-pressure-cancel-btn", svgIcon("close"));
      cancelBtn.type = "button";
      cancelBtn.title = "Cancel";
      actionCell.appendChild(cancelBtn);
      row._cancelBtn = cancelBtn;

      // Up/Down - reorders this row relative to every OTHER registered
      // device, of either type (moveDeviceRow() above), independent of
      // the edit lock above (no need to press the pencil first).
      // Physically the slot doesn't move at all, only the Sort Order
      // metadata each device carries - see that number entity's own
      // comment in pressure_sensor.yaml. Disabled at whichever end of the
      // list a row already sits at (isFirst/isLast below), rather than
      // just being a no-op click - visibly not just cosmetically
      // first/last.
      const orderGroup = el("div", "hub-pressure-order-group");
      row.querySelector(".hub-pressure-order").appendChild(orderGroup);
      const upBtn = el("button", "hub-pressure-icon-btn hub-pressure-order-btn", svgIcon("chevronUp"));
      upBtn.type = "button";
      upBtn.title = "Move up";
      upBtn.addEventListener("click", () => moveDeviceRow(groupName, -1));
      const downBtn = el("button", "hub-pressure-icon-btn hub-pressure-order-btn", svgIcon("chevronDown"));
      downBtn.type = "button";
      downBtn.title = "Move down";
      downBtn.addEventListener("click", () => moveDeviceRow(groupName, 1));
      orderGroup.append(upBtn, downBtn);
      row._upBtn = upBtn;
      row._downBtn = downBtn;

      // Expand row - Modbus Address always, plus a Flow-only Reading/
      // Update pair (built once up front like everything else here, but
      // only shown when this slot is currently Flow-typed - see the
      // deviceType-driven .hidden toggle below, re-checked on every
      // render since a slot's Device Type can change after Add) - same
      // "only exists while editing" pattern as the pulse meters' own
      // expand row, and the same Reading/Update UX they already have
      // (pressureSensor.yaml's own ${id_prefix}_flow_offset_m3 comment
      // explains why Flow-type slots need this correction in software
      // rather than writing the device directly, unlike a pulse meter's
      // own count).
      const expandedRow = el("tr", "hub-pulsemeter-expanded");
      const expandedCell = document.createElement("td");
      expandedCell.colSpan = 4;
      expandedRow.appendChild(expandedCell);
      const addrLine = el("div", "hub-pulsemeter-expanded-field");
      const addrLabel = el("span", "hub-pulsemeter-expanded-label", "Modbus Address");
      const addrInput = document.createElement("input");
      addrInput.type = "number";
      addrInput.min = 1;
      addrInput.max = 247;
      addrInput.step = 1;
      addrInput.className = "hub-addr-input";
      addrLine.append(addrLabel, addrInput);
      expandedCell.appendChild(addrLine);
      row._expandedRow = expandedRow;
      row._addrInput = addrInput;

      const readingLine = el("div", "hub-pulsemeter-expanded-field");
      const readingLabel = el("span", "hub-pulsemeter-expanded-label", "Reading");
      const readingInput = document.createElement("input");
      // text + inputmode: "decimal", NOT type="number" - Safari's native
      // number-input widget silently re-renders an assigned .value using
      // the device's own locale AND its own rounding (a full-precision
      // "0.062692" can show back as "99999,13" - comma decimal
      // separator, fewer digits, matching neither the actual value nor
      // this field's own configured step). A plain text input with a
      // decimal-hinting keyboard sidesteps that entirely - whatever this
      // file assigns to .value is exactly what's shown, full stop. All
      // validation here was already hand-rolled in JS (parseFloat, min/
      // max checks below) - never relied on the browser's own number-
      // input semantics to begin with, so nothing else changes.
      readingInput.type = "text";
      readingInput.inputMode = "decimal";
      // Own class purely so its width can be sized for what it actually
      // holds (a full-precision meter reading, e.g. "12345.123456")
      // without also widening the Modbus Address box next to it, which
      // holds at most 3 digits - see dashboard.css.
      readingInput.className = "hub-reading-input";
      const updateBtn = el("button", "hub-btn hub-btn-compact", "Update");
      updateBtn.type = "button";
      readingLine.append(readingLabel, readingInput, updateBtn);
      readingLine.hidden = true;
      expandedCell.appendChild(readingLine);
      row._readingLine = readingLine;
      row._readingInput = readingInput;
      row._updateBtn = updateBtn;
      // Reading field lifecycle - see READING_CLEAN's own comment for
      // why this needs three states and not a "dirty" boolean.
      row._readingState = READING_CLEAN;
      readingInput.addEventListener("input", () => {
        row._readingState = READING_DIRTY;
        // updateSaveEnabled is defined further down, in the same closure
        // (this listener only ever fires later, well after that
        // definition has run) - same forward-reference shape already
        // used a few lines below for row._cancelEdit().
        updateSaveEnabled();
      });
      // Software-only, never reaches the meter itself - see HELP_TEXT's
      // own "Reading"/"Update" text for the full explanation; the "?"
      // sits on this row rather than the label alone so it's easy to
      // find next to the input people are about to type into.
      attachHelp(readingLine, HELP_TEXT["Update"]);

      // Read-only correction display + its own Reset (see
      // ${id_prefix}_flow_offset's own comment in pressure_sensor.yaml) -
      // shown right under Reading/Update so it's obvious a correction is
      // currently applied, and by how much, without having to dig into
      // System/Diagnostics for it. Same visibility rule as readingLine
      // (Flow-type slots only), toggled together below.
      const correctionLine = el("div", "hub-pulsemeter-expanded-field");
      const correctionLabel = el("span", "hub-pulsemeter-expanded-label", "Correction");
      const correctionValue = el("span", "hub-pulsemeter-expanded-value", "");
      const resetBtn = el("button", "hub-btn hub-btn-compact", "Reset");
      resetBtn.type = "button";
      correctionLine.append(correctionLabel, correctionValue, resetBtn);
      correctionLine.hidden = true;
      expandedCell.appendChild(correctionLine);
      row._correctionLine = correctionLine;
      row._correctionValue = correctionValue;
      row._resetBtn = resetBtn;
      attachHelp(correctionLine, HELP_TEXT["Correction Offset"]);

      // Device info pair (pressure_sensor.yaml's own comment on Range
      // Low explains the field selection/exclusions) - plain read-only
      // display, no input/button, shown only for Flow-type slots
      // (toggled alongside readingLine/correctionLine below). A Range
      // Low/High pair was tried here for Pressure-type too and dropped:
      // a fixed factory spec, not a live reading, wasn't worth the row.
      const batteryLine = el("div", "hub-pulsemeter-expanded-field");
      batteryLine.append(el("span", "hub-pulsemeter-expanded-label", "Battery"), el("span", "hub-pulsemeter-expanded-value", ""));
      batteryLine.hidden = true;
      expandedCell.appendChild(batteryLine);
      row._batteryLine = batteryLine;
      row._batteryValue = batteryLine.lastElementChild;
      attachHelp(batteryLine, HELP_TEXT["Battery Voltage"]);

      // Same Reading/Update wiring as upsertPulseMeterExpandedField()
      // uses for pulse meters (see that function's own comment for the
      // Enter/Escape reasoning) - inlined here rather than shared, since
      // pressure rows are rebuilt via renderDeviceTableBody() on every
      // update rather than routed through a per-entity dispatch function.
      // Deliberately NO `change`/blur handler that "corrects" the field.
      // One used to live here (and in the pulse meter twin) and put the
      // live Total Consumption back whenever the typed value didn't
      // parse or fell outside the range. That is wrong twice over: it
      // throws away what someone was in the middle of typing, and -
      // because a real mouse click blurs the input BEFORE the button's
      // own click handler runs - Update then read the value the change
      // handler had just written rather than the value on screen when
      // the user clicked. On a meter reading 0 that meant an invalid
      // entry could turn into "apply 0 to the accumulated total". All
      // validation now happens in exactly one place, the explicit Update
      // action (applyTypedReading()), which leaves a bad draft alone so
      // it can be corrected.
      readingInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          updateBtn.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          row._cancelEdit();
        }
      });
      updateBtn.addEventListener("click", async () => {
        await applyTypedReading({ groupName, input: readingInput, button: updateBtn, row });
      });

      // Whether Save has anything at all to send - same reasoning as the
      // pulse meter's own twin (upsertPulseMeterExpandedField's
      // updateSaveEnabled). Name and Modbus Address compare the typed
      // value against what editing started with; Reading reuses its own
      // READING_DIRTY signal, same as Update's own existing behavior
      // (not re-checked against the live value, so retyping the exact
      // original reading still counts as changed). A Pressure-type
      // slot's Reading field is hidden (readingLine.hidden below) and so
      // can never become DIRTY in the first place - no separate type
      // check needed here for that.
      const updateSaveEnabled = () => {
        const nameChanged = nameInput.value !== row._editOrigName;
        const addrChanged = addrInput.value !== row._editOrigAddr;
        const readingChanged = row._readingState === READING_DIRTY;
        saveBtn.disabled = !(nameChanged || addrChanged || readingChanged);
      };
      nameInput.addEventListener("input", updateSaveEnabled);
      addrInput.addEventListener("input", updateSaveEnabled);

      const enterEdit = () => {
        // Only one row editable at a time, table-wide (either type) -
        // opening this one force-cancels/closes whichever other row was
        // already open, discarding any unsaved edit there too (same as
        // if its own Cancel had been pressed). Also closes the Add row if
        // it's open (closeDeviceAddRow()) - same "only one interactive
        // thing open at once" rule, the other direction (see
        // toggleDeviceAdd()'s own comment).
        if (deviceEditingRow && deviceEditingRow !== row && deviceEditingRow._cancelEdit) {
          deviceEditingRow._cancelEdit();
        }
        closeDeviceAddRow();
        deviceEditingRow = row;
        row._editOrigName = nameInput.value;
        row._editOrigAddr = addrInput.value;
        row._readingPending = 0;
        row._readingState = READING_CLEAN;
        nameInput.disabled = false;
        addrInput.disabled = false;
        row.classList.add("hub-pressure-row-editing");
        row._editing = true;
        tbody.insertBefore(expandedRow, row.nextSibling);
        nameInput.focus();
        nameInput.select();
        // Battery Voltage/Range Low/Range High (pressure_sensor.yaml's
        // own comment on those sensors explains why) only exist as of
        // this on-demand read - fired once, right as the row opens, not
        // on any background timer. Best-effort: a failure here just
        // leaves the device-info lines showing "--"/stale, same as any
        // other momentary read miss elsewhere in this file - not worth
        // an error popup for a refresh nobody explicitly asked for.
        const refreshEntity = pressureSlotEntity(groupName, "Refresh Device Info");
        if (refreshEntity) postRequest(`${refreshEntity.namePath}/press`).catch(() => {});
        updateSaveEnabled(); // nothing typed yet - starts disabled
      };
      const exitEdit = () => {
        nameInput.disabled = true;
        addrInput.disabled = true;
        row.classList.remove("hub-pressure-row-editing");
        row._editing = false;
        if (expandedRow.isConnected) expandedRow.remove();
        if (deviceEditingRow === row) deviceEditingRow = null;
        saveBtn.disabled = true;
      };
      const cancelEdit = () => {
        nameInput.value = row._editOrigName;
        addrInput.value = row._editOrigAddr;
        // Reading has no "orig" snapshot of its own - same reasoning as
        // upsertPulseMeterExpandedField()'s own Reading field: it only
        // ever commits through its own explicit Update press, never
        // through this row's Save, so reverting it just means going back
        // to whatever Total Consumption currently reads, not undoing a
        // typed-but-uncommitted edit that was never going to be saved by
        // Cancel anyway.
        const live = pressureSlotEntity(groupName, "Total Consumption");
        readingInput.value = live ? fmtValue(live) : "";
        row._readingPending = 0;
        row._readingState = READING_CLEAN;
        exitEdit();
      };
      row._cancelEdit = cancelEdit;
      editBtn.addEventListener("click", enterEdit);
      cancelBtn.addEventListener("click", cancelEdit);
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
      saveBtn.addEventListener("click", async () => {
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
        if (dupe) {
          alert(
            `Address ${parsed} is already registered as "${dupe}". Setting it here would reprogram this sensor onto an address already in use, causing a real bus collision - choose a different address, or change/remove "${dupe}" first.`
          );
          return; // stay in edit mode - no override allowed
        }
        saveBtn.disabled = true;
        cancelBtn.disabled = true;
        // Declared here, assigned only once actually armed below - so
        // the catch block's `if (outcome) outcome.cancel()` stays a
        // correct no-op for every path that never gets that far
        // (including the Reading step returning early).
        let outcome = null;
        try {
          // Reading (Flow-type slots only - a Pressure-type slot's field
          // is hidden and can never be DIRTY) commits through the SAME
          // applyTypedReading() its own Update button uses - only when
          // actually typed into - deliberately BEFORE anything about the
          // address change below is even computed. watchUpdateResult()
          // a few lines down starts a fixed 4s window for the DEVICE's
          // own reply, not for how long a person takes to answer a
          // confirm() dialog; starting it before this step could let it
          // expire while someone was still deciding, and read back as
          // "the device never confirmed" for an address write that had
          // not even been sent yet. A declined reading confirmation
          // cancels the whole Save, address change included - a "no" to
          // one question must not quietly carry out the other, higher-
          // consequence one.
          if (row._readingState === READING_DIRTY) {
            const applied = await applyTypedReading({ groupName, input: readingInput, button: updateBtn, row });
            if (!applied) return; // stays in edit mode; applyTypedReading already left the field truthful
          }
          const ne = pressureSlotEntity(groupName, "Display Name");
          const ae = pressureSlotEntity(groupName, "Modbus Address");
          // Changing the address of a sensor that already has one is not a
          // setting - it reprograms the physical device over the bus, and
          // that can fail (unpowered, unplugged, one RS485 conductor off).
          // The device then puts the old address back, and without this the
          // whole thing was silent: the POST returns 200 the moment the
          // request is received, the row closes, and the old address is
          // simply there again with nothing saying why. Same channel and
          // same reasoning as applyTypedReading() above.
          const previous = ae ? Number(ae.value) : NaN;
          const reprogramming = Number.isFinite(previous) && previous !== 0 && previous !== parsed;
          outcome = reprogramming ? watchUpdateResult(groupName, String(parsed)) : null;
          const addressRequestEntity = pressureSlotEntity(groupName, "Address Change Request");
          // A persistent Number is configuration, not authority to replay
          // a physical bus write. Arm this exact old->new transition once,
          // with a nonce, then send the Number POST only after the arm was
          // accepted. Firmware consumes the arm before touching RS485.
          if (reprogramming) {
            if (!addressRequestEntity) throw new Error("Address-change safety interlock is unavailable");
            const nonceArray = new Uint32Array(1);
            crypto.getRandomValues(nonceArray);
            const nonce = nonceArray[0] || 1;
            const request = `${previous},${parsed},${nonce}`;
            await postRequest(`${addressRequestEntity.namePath}/set?value=${encodeURIComponent(request)}`);
          }
          const requests = [];
          if (ne) requests.push(postRequest(`${ne.namePath}/set?value=${encodeURIComponent(nameInput.value)}`));
          if (ae) requests.push(postRequest(`${ae.namePath}/set?value=${encodeURIComponent(parsed)}`));
          await Promise.all(requests);
          // null = the device never reported back (an SSE hiccup, or
          // firmware older than this channel). Unknown is not failure, so
          // it is left to the live address to speak for itself.
          const result = outcome ? await outcome.promise : null;
          if (result && result.status === "contended") {
            // Not a failure to write - a refusal to write at all. A
            // Modbus write goes to an address, not to a device, so on a
            // shared address it reaches both, and there is no way to
            // move just one of them. Saying "try again" here would be
            // advice that cannot work.
            alert(
              `More than one device answers on address ${previous}, so nothing was written. A write goes to the ` +
                `address, not to one device - both would receive it, and on a different model the same register ` +
                `numbers can mean something else entirely. Disconnect one of them, then change the address of the ` +
                `one still on the bus.`
            );
          } else if (result && result.status === "occupied") {
            alert(
              `Something already answers on address ${parsed}, so nothing was written - moving this sensor there ` +
                `would put two devices on one address. Pick an address nothing is using; Scan Bus shows which are ` +
                `taken.`
            );
          } else if (result && result.status === "unverified") {
            // The device answers on neither address. The firmware keeps
            // the new one (see the Modbus Address set_action for why
            // that is the better guess), so what this needs to say is
            // where to look - not "it failed", which would be a claim
            // nobody can back up.
            alert(
              `The sensor did not confirm the change from ${previous} to ${parsed}, and it is not answering on ` +
                `${previous} either - so it has most likely moved and ${parsed} has been kept here. Run Scan Bus ` +
                `to find which address it is really on.`
            );
          } else if (result && result.status === "unauthorized") {
            alert(
              `The address-change safety check rejected this request, so no Modbus write was sent. ` +
                `Reload the dashboard and try the change again.`
            );
          } else if (result && result.status !== "ok") {
            alert(
              `The sensor is still answering on address ${previous} and did not switch to ${parsed}, so its ` +
                `address is unchanged. Check that it is powered and that both RS485 conductors are connected, ` +
                `then try again.`
            );
          }
          exitEdit();
        } catch (error) {
          if (outcome) outcome.cancel();
          showRequestError(error, "Device update failed");
        } finally {
          cancelBtn.disabled = false;
          // Not a blind re-enable: exitEdit() above already set Save
          // disabled (and left edit mode) on success, and must stay
          // that way - so this only recomputes it, from whatever is
          // actually still dirty, when still in edit mode (a declined
          // reading confirmation, or a failed step, returned early
          // without exiting).
          if (row._editing) updateSaveEnabled();
        }
      });
    }
    if (delEntity) delEntity.btnEl = row._delBtn;
    row._delBtn.onclick = () => {
      if (delEntity) pressButton(delEntity);
    };
    // Looked up fresh every render, same as delEntity above - this
    // entity only exists once its own "state" event has arrived, which
    // can be after the row itself was first built.
    const resetEntity = pressureSlotEntity(groupName, "Reset Correction");
    if (resetEntity) resetEntity.btnEl = row._resetBtn;
    row._resetBtn.onclick = () => {
      if (resetEntity) {
        // An explicit "give me the raw value back" action - discards
        // whatever's typed in Reading (if anything), same as Cancel.
        row._readingPending = 0;
        row._readingState = READING_CLEAN;
        pressButton(resetEntity);
      }
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
    // Only a field nobody is working on gets refreshed from live state.
    // While it is dirty (typed but not applied) or pending (applied,
    // waiting for the device's verdict) it is off limits - see
    // readingFieldIsIdle().
    if (readingFieldIsIdle(row)) {
      const totalEntity = pressureSlotEntity(groupName, "Total Consumption");
      row._readingInput.value = totalEntity ? fmtValue(totalEntity) : "";
    }
    // Correction Offset always reflects the live entity, even mid-edit -
    // it's a read-only display, not an editable draft like Reading above,
    // so there's no local/unsaved value it could ever clobber.
    const offsetEntity = pressureSlotEntity(groupName, "Correction Offset");
    const offsetValue = offsetEntity && typeof offsetEntity.value === "number" ? offsetEntity.value : 0;
    const offsetUom = offsetEntity && offsetEntity.uom ? ` ${offsetEntity.uom}` : "";
    // fmtValue(), not a client-side round - same "don't cut off real
    // digits" reasoning as everywhere else in this file. The Reset
    // button's enabled state still uses the raw offsetValue directly (an
    // exact-zero comparison there is more correct than checking a
    // rounded copy - a real correction too small to show at the
    // configured precision still gets a working Reset). The "+" prefix
    // is suppressed when the shown digits are all zero, for the same
    // reason stripNegativeZero() drops a "-" there: a sign in front of a
    // displayed zero says nothing and just looks broken.
    const offsetShown = offsetEntity ? fmtValue(offsetEntity) : "0";
    const offsetShowsZero = /^0(\.0*)?$/.test(offsetShown);
    row._correctionValue.textContent = offsetEntity
      ? `${offsetValue > 0 && !offsetShowsZero ? "+" : ""}${offsetShown}${offsetUom}`
      : "0";
    row._resetBtn.disabled = offsetValue === 0;
    // Battery Voltage - same "always live, read-only" treatment as
    // Correction Offset above, missing/NaN reads show "--" rather than a
    // stale or blank line (same convention fmtValue() uses everywhere
    // else in this file).
    const batteryEntity = pressureSlotEntity(groupName, "Battery Voltage");
    row._batteryValue.textContent = batteryEntity ? fmtValue(batteryEntity) + (batteryEntity.uom ? ` ${batteryEntity.uom}` : "") : "--";
    const status = pressureStatusState(online, hasCollision, hasMismatch);
    row._statusEl.textContent = status.text;
    for (const c of PRESSURE_BADGE_CLASSES) row._statusEl.classList.toggle(c, c === status.cssClass);
    updateHomeCardStatus(groupName, status.text, status.cssClass);
    row._upBtn.disabled = !!isFirst;
    row._downBtn.disabled = !!isLast;
    // Device Type is editable after Add too (see that select's own
    // comment in pressure_sensor.yaml), so re-checked every render, not
    // just set once at row creation. "dot" (neutral), not "gauge", while
    // deviceType is undefined (not known yet, distinct from an actual
    // "Pressure" reading - see registeredPressureSlots()'s own comment).
    row._typeIconEl.innerHTML = svgIcon(deviceType === "Flow" ? "flow" : deviceType === "Pressure" ? "gauge" : "dot");
    // Reading/Update (and Correction Offset/Reset alongside it) only make
    // sense for Flow-type slots (Pressure has no accumulated total to
    // correct) - re-checked every render for the same reason as the icon
    // line just above: Device Type can change after Add.
    row._readingLine.hidden = deviceType !== "Flow";
    row._correctionLine.hidden = deviceType !== "Flow";
    row._batteryLine.hidden = deviceType !== "Flow";
    // Mirrors what upsertServiceText() does for the water meters -
    // this slot's Home card header uses the same shared groupLabel()/
    // refreshGroupLabel() machinery, which otherwise has no other way to
    // learn this group's renamed Display Name, since pressure entities
    // never reach upsertServiceText() at all.
    if (nameEntity) {
      groupDisplayNames.set(groupName, (nameEntity.value || "").trim());
      applyGroupLabel(groupName);
    }
  }

  function upsertNewPressureRow(tbody, address, atCeiling) {
    const key = "new:" + address;
    let row = deviceTableRows.get(key);
    if (!row) {
      row = el(
        "tr",
        "hub-pressure-row-new",
        `<td class="hub-pressure-name"></td><td class="hub-pressure-status"><span class="hub-pressure-badge hub-pressure-badge-new">New</span></td><td class="hub-pressure-action"></td><td class="hub-pressure-order"></td>`
      );
      deviceTableRows.set(key, row);
      tbody.appendChild(row);

      const nameCell = row.querySelector(".hub-pressure-name");
      const nameRow = el("div", "hub-pressure-name-row");
      nameCell.appendChild(nameRow);
      const typeIcon = el("span", "hub-device-type-icon", svgIcon("dot"));
      nameRow.appendChild(typeIcon);
      row._typeIconEl = typeIcon;
      const nameContent = el("div", "hub-pressure-name-content");
      nameRow.appendChild(nameContent);
      nameContent.appendChild(el("span", "hub-pressure-addr-hint", `Modbus address: ${address}`));

      const editRow = el("div", "hub-pressure-name-edit-row");
      nameContent.appendChild(editRow);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 32;
      nameInput.placeholder = "Device name";
      nameInput.autocomplete = "off";
      nameInput.value = pressureNewRowDrafts.get(address) || "";
      nameInput.addEventListener("input", () => {
        pressureNewRowDrafts.set(address, nameInput.value);
        // Live, not just on the next render - a name typed and then
        // immediately clicked past shouldn't have to wait for an SSE
        // round trip to unlock Confirm. atCeiling itself is a snapshot
        // from this row's creation, same as every other read of it in
        // this function - reconciled again on the next real render
        // regardless.
        if (!row._confirmBtn._busy) row._confirmBtn.disabled = atCeiling || !nameInput.value.trim() || !typeSelect.value;
      });
      editRow.appendChild(nameInput);
      row._nameInput = nameInput;

      const typeSelect = document.createElement("select");
      typeSelect.className = "hub-pressure-type-select";
      typeSelect.innerHTML = `<option value="" selected disabled>Type…</option><option value="Pressure">Pressure</option><option value="Flow">Flow</option>`;
      editRow.appendChild(typeSelect);
      row._typeSelect = typeSelect;
      // Pre-filled from what the scan found the device to BE, when it
      // could tell. The dropdown stays exactly as it was - this is a
      // starting point, not a lock - but nobody should have to know
      // which box on the wall is which, and a wrong guess here is not
      // cosmetic: the slot would poll a register block that means
      // something else on that instrument. Left blank when the
      // fingerprint did not recognise the device, because "we cannot
      // tell" is a real answer and inventing one would be worse than
      // asking.
      const detectedType = latestScanTypes().get(address);
      if (detectedType) typeSelect.value = detectedType;

      const typeHint = el("span", "hub-pressure-type-hint", TYPE_READING_HINT[""]);
      nameContent.appendChild(typeHint);
      const updateTypePreview = () => {
        const flow = typeSelect.value === "Flow";
        typeIcon.innerHTML = svgIcon(typeSelect.value ? (flow ? "flow" : "gauge") : "dot");
        typeHint.textContent = TYPE_READING_HINT[typeSelect.value];
        if (!row._confirmBtn._busy) row._confirmBtn.disabled = atCeiling || !nameInput.value.trim() || !typeSelect.value;
      };
      row._updateTypePreview = updateTypePreview;
      typeSelect.addEventListener("change", () => {
        // A hand-picked type is final: the scan's own answer must never
        // overwrite it on some later render (see the reconciliation at
        // the end of this function).
        row._typeTouched = true;
        updateTypePreview();
      });

      const actionCell = row.querySelector(".hub-pressure-action");

      const confirmBtn = el("button", "hub-pressure-icon-btn hub-pressure-save-btn", svgIcon("check"));
      confirmBtn.type = "button";
      confirmBtn.disabled = true;
      actionCell.appendChild(confirmBtn);
      confirmBtn.addEventListener("click", async () => {
        if (confirmBtn.disabled) return;
        const nameEntity = pressureSlotEntity(PRESSURE_ADD_GROUP, "Add Name");
        const addrEntity = pressureSlotEntity(PRESSURE_ADD_GROUP, "Add Target Address");
        const typeEntity = pressureSlotEntity(PRESSURE_ADD_GROUP, "Add Device Type");
        const addEntity = pressureSlotEntity(PRESSURE_ADD_GROUP, "Add");
        if (!nameEntity || !addrEntity || !typeEntity || !addEntity) return; // not seen yet - shouldn't happen once connected
        const name = row._nameInput.value;
        const deviceType = row._typeSelect.value;
        // Disabled for the round-trip's duration, not just the ceiling
        // check below - guards against a double-click firing this whole
        // chain twice, which (even with the shared-flag fix in
        // pressure_sensor.yaml's try_register) could still let two
        // separate Add presses each claim a slot for the same address.
        confirmBtn._busy = true;
        confirmBtn.disabled = true;
        const outcome = watchAddResult();
        try {
          await postRequest(`${nameEntity.namePath}/set?value=${encodeURIComponent(name)}`);
          // ESPHome select endpoints use `option`; number/text endpoints
          // use `value`.
          await postRequest(`${typeEntity.namePath}/set?option=${encodeURIComponent(deviceType)}`);
          await postRequest(`${addrEntity.namePath}/set?value=${encodeURIComponent(address)}`);
          await postRequest(`${addEntity.namePath}/press`);
          const status = await outcome.promise;
          if (status && status !== "ok") {
            // The device checks the instrument itself before registering
            // it, and a refusal has to reach the person who asked -
            // otherwise the row just sits there and never becomes a
            // device, which is how a pressure transmitter registered
            // onto a flow meter's slot went unnoticed.
            const actual = latestScanTypes().get(address);
            alert(
              status === "wrong_type"
                ? `The device on address ${address} is not a ${deviceType}${actual ? ` - it identifies as ${actual}` : ""}. ` +
                  `Registering it as the wrong type would make this slot read the wrong registers, so it was not added. ` +
                  `Choose the right type and try again.`
                : status === "collision"
                  ? `More than one device answers on address ${address}, so it was not added. Give each device its own ` +
                    `address - with two on the same one there is no way to tell which is which.`
                  : `Nothing answered on address ${address}, so it was not added. Check that the device is powered and ` +
                    `that both RS485 conductors are connected, then scan again.`
            );
            return;
          }
          pressureNewRowDrafts.delete(address);
        } catch (error) {
          outcome.cancel();
          showRequestError(error, "Device add failed");
        } finally {
          confirmBtn._busy = false;
          confirmBtn.disabled = atCeiling;
        }
      });
      row._confirmBtn = confirmBtn;
      // Run the type preview once for the value pre-filled from the scan
      // above, so the type icon and the reading hint start out agreeing
      // with the dropdown instead of waiting for someone to change it.
      // Has to be after _confirmBtn exists - it reads that button's own
      // state.
      updateTypePreview();

      const dismissBtn = el("button", "hub-pressure-icon-btn hub-pressure-cancel-btn", svgIcon("close"));
      dismissBtn.type = "button";
      dismissBtn.title = "Dismiss (until the next scan)";
      actionCell.appendChild(dismissBtn);
      dismissBtn.addEventListener("click", () => {
        dismissedScanAddresses.add(address);
        pressureNewRowDrafts.delete(address);
        renderDeviceTableBody();
      });

      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          confirmBtn.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          dismissBtn.click();
        }
      });
    }
    // Never overrides an in-flight request's own disabled state (see the
    // click handler's _busy flag above) - a re-render (any SSE update)
    // landing mid-request would otherwise reset disabled back to
    // whatever atCeiling says here, undoing that guard.
    // The detected type is applied on every render, not only when the row
    // is built. The scan publishes its ADDRESSES first and the types it
    // worked out for them a moment later, so the row already exists by
    // the time its type is known - prefilling once at creation left the
    // dropdown empty for exactly the case it was written for. Never over
    // a choice someone made by hand.
    if (!row._typeTouched) {
      const detected = latestScanTypes().get(address);
      if (detected && row._typeSelect.value !== detected) {
        row._typeSelect.value = detected;
        row._updateTypePreview();
      }
    }
    if (!row._confirmBtn._busy) {
      const nameEmpty = !row._nameInput.value.trim();
      const typeUnset = !row._typeSelect.value;
      row._confirmBtn.disabled = atCeiling || nameEmpty || typeUnset;
      row._confirmBtn.title = atCeiling
        ? `All ${PRESSURE_MAX_SLOTS} sensor slots are already registered - delete one first to add another.`
        : nameEmpty
          ? "Enter a name first."
          : typeUnset
            ? "Choose a device type first."
            : "Add";
    }
  }

  // An address the scan's AddressInspector proved a collision on
  // (latestCollisionAddresses() above) and no slot already claims it -
  // informational only, deliberately no Add button: there's no single
  // device identity here to register (adding it would just register
  // whichever device happens to win bus arbitration on a given poll,
  // silently), see include/rs485_modbus.h's AddressInspector for why
  // this reading is a strong, correlated signal but still not absolute
  // proof (two bit-identical devices in lockstep are indistinguishable
  // from one).
  function upsertCollisionPressureRow(tbody, address) {
    const key = "collision:" + address;
    let row = deviceTableRows.get(key);
    if (!row) {
      row = el(
        "tr",
        "hub-pressure-row-collision",
        `<td class="hub-pressure-name"></td>` +
          `<td class="hub-pressure-status"><span class="hub-pressure-badge hub-pressure-badge-collision">Collision</span></td>` +
          `<td class="hub-pressure-action"></td>` +
          `<td class="hub-pressure-order"></td>`
      );
      deviceTableRows.set(key, row);
      tbody.appendChild(row);
      const nameCell = row.querySelector(".hub-pressure-name");
      const nameRow = el("div", "hub-pressure-name-row");
      nameCell.appendChild(nameRow);
      nameRow.appendChild(el("span", "hub-device-type-icon", svgIcon("gauge")));
      const nameContent = el("div", "hub-pressure-name-content");
      nameRow.appendChild(nameContent);
      nameContent.appendChild(el("span", "hub-pressure-addr-hint", `Modbus address: ${address}`));
      nameContent.appendChild(el("span", "hub-pressure-collision-note", "Multiple devices may share this address"));
    }
  }

  function updateDeviceEmptyState(tbody, isEmpty) {
    let placeholder = tbody.querySelector(".hub-pressure-empty");
    if (isEmpty && !placeholder) {
      placeholder = el(
        "tr",
        "hub-pressure-empty",
        `<td colspan="4">No devices yet - press "Find Modbus Devices" to scan for a Modbus sensor, or use the "Add Pulse Meter" button below.</td>`
      );
      tbody.appendChild(placeholder);
    } else if (!isEmpty && placeholder) {
      placeholder.remove();
    }
  }

  const dismissedScanAddresses = new Set();

  function suppressStaleHover(tbody) {
    tbody.classList.add("hub-pressure-table-settling");
    document.addEventListener("mousemove", () => tbody.classList.remove("hub-pressure-table-settling"), { once: true });
  }

  // Coalesces a burst of state events into one rebuild - see the call
  // site in renderPressureEntity() for why. setTimeout rather than
  // requestAnimationFrame deliberately: rAF doesn't fire in a background
  // tab, which would leave a pending rebuild parked indefinitely.
  let deviceTableRenderPending = false;

  function scheduleDeviceTableRender() {
    if (deviceTableRenderPending) return;
    deviceTableRenderPending = true;
    setTimeout(() => {
      deviceTableRenderPending = false;
      renderDeviceTableBody();
    }, 50);
  }

  function renderDeviceTableBody() {
    const tbody = ensureDeviceTable();
    if (!tbody) return;
    refreshDeviceAddButtons();
    const registered = registeredPressureSlots();
    const registeredAddresses = new Set(registered.map((s) => s.address));
    const scanAddresses = latestScanAddresses();
    const collisionAddresses = latestCollisionAddresses();
    const collisionSet = new Set(collisionAddresses);
    const mismatchSet = new Set(latestMismatchAddresses());
    const atCeiling = registered.length >= PRESSURE_MAX_SLOTS;

    const seenKeys = new Set();
    const desiredOrder = [];

    const orderedRegistered = orderedRegisteredDevices();
    orderedRegistered.forEach((d, i) => {
      seenKeys.add("reg:" + d.groupName);
      if (d.type === "pressure") {
        upsertRegisteredPressureRow(
          tbody,
          d.groupName,
          d.online, // tri-state: true/false/undefined ("never polled yet") - see upsertRegisteredPressureRow()'s own comment
          collisionSet.has(d.address),
          mismatchSet.has(d.address),
          i === 0,
          i === orderedRegistered.length - 1,
          d.deviceType
        );
      } else {
        upsertRegisteredPulseMeterRow(tbody, d.groupName, i === 0, i === orderedRegistered.length - 1);
      }
      const row = deviceTableRows.get("reg:" + d.groupName);
      desiredOrder.push(row);
      // The open row's own expanded detail row (if any) always
      // immediately follows it - not a separate deviceTableRows entry,
      // tracked instead as row._expandedRow.
      if (row && row._editing && row._expandedRow) desiredOrder.push(row._expandedRow);
    });

    const newAddresses = scanResultsFresh
      ? [...new Set(scanAddresses)]
          .filter((a) => !registeredAddresses.has(a) && !dismissedScanAddresses.has(a))
          .sort((a, b) => a - b)
      : [];
    for (const address of newAddresses) {
      seenKeys.add("new:" + address);
      upsertNewPressureRow(tbody, address, atCeiling);
      desiredOrder.push(deviceTableRows.get("new:" + address));
    }
    const unclaimedCollisions = scanResultsFresh
      ? [...new Set(collisionAddresses)].filter((a) => !registeredAddresses.has(a)).sort((a, b) => a - b)
      : [];
    for (const address of unclaimedCollisions) {
      seenKeys.add("collision:" + address);
      upsertCollisionPressureRow(tbody, address);
      desiredOrder.push(deviceTableRows.get("collision:" + address));
    }

    if (deviceAddOpen) {
      if (!deviceAddRow) deviceAddRow = buildDeviceAddRow();
      refreshDeviceAddRow();
      if (!deviceAddRow.isConnected) tbody.appendChild(deviceAddRow);
      desiredOrder.push(deviceAddRow);
    } else if (deviceAddRow && deviceAddRow.isConnected) {
      deviceAddRow.remove();
    }

    let anchor = tbody.firstElementChild;
    for (const row of desiredOrder) {
      if (!row) continue;
      if (anchor === row) {
        anchor = anchor.nextElementSibling;
      } else {
        tbody.insertBefore(row, anchor);
      }
    }

    let removedAny = false;
    for (const [key, row] of deviceTableRows) {
      if (!seenKeys.has(key)) {
        if (row._expandedRow && row._expandedRow.isConnected) row._expandedRow.remove();
        row.remove();
        deviceTableRows.delete(key);
        removedAny = true;
      }
    }
    if (removedAny) suppressStaleHover(tbody);
    updateDeviceEmptyState(tbody, seenKeys.size === 0);
    resyncDeviceHomeCardOrder();
  }

  let deviceAddOpen = false;
  let deviceAddRow = null;

  // Closes the Add row, if open, without going through a full
  // renderDeviceTableBody() - called from enterEdit() (either row type)
  // so starting an edit closes a currently-open Add, the reverse of
  // toggleDeviceAdd()'s own "opening Add closes a currently-open edit".
  function closeDeviceAddRow() {
    if (!deviceAddOpen) return;
    deviceAddOpen = false;
    if (deviceAddRow) {
      // See buildDeviceAddRow()'s own resetForm() comment - this row is
      // reused across open/close cycles, so a typed-but-unconfirmed name
      // must be cleared here too, not just on Cancel/successful Add.
      if (deviceAddRow._nameInput) deviceAddRow._nameInput.value = "";
      if (deviceAddRow._errorEl) deviceAddRow._errorEl.textContent = "";
      // See _slotSelectTouched's own comment (buildDeviceAddRow()) - each
      // new Add session should default to the first free slot, not
      // whatever was left selected from a previous session.
      deviceAddRow._slotSelectTouched = false;
      if (deviceAddRow.isConnected) deviceAddRow.remove();
    }
  }

  function buildDeviceAddRow() {
    const row = el("tr", "hub-device-add-row");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    row.appendChild(cell);

    const form = el("div", "hub-device-add-form");
    cell.appendChild(form);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 32;
    nameInput.placeholder = "Device name";
    nameInput.autocomplete = "off";
    const slotSelect = document.createElement("select");

    const errorEl = el("span", "hub-device-add-error", "");

    const confirmBtn = el("button", "hub-pressure-icon-btn hub-pressure-save-btn", svgIcon("check"));
    confirmBtn.type = "button";
    confirmBtn.title = "Add";
    const cancelBtn = el("button", "hub-pressure-icon-btn hub-pressure-cancel-btn", svgIcon("close"));
    cancelBtn.type = "button";
    cancelBtn.title = "Cancel";

    form.append(nameInput, slotSelect, confirmBtn, cancelBtn, errorEl);

    row._nameInput = nameInput;
    row._slotSelect = slotSelect;
    row._errorEl = errorEl;
    row._slotSelectTouched = false;
    slotSelect.addEventListener("change", () => {
      row._slotSelectTouched = true;
    });

    const resetForm = () => {
      nameInput.value = "";
      errorEl.textContent = "";
      row._slotSelectTouched = false;
    };

    const cancel = () => {
      deviceAddOpen = false;
      resetForm();
      renderDeviceTableBody();
    };
    cancelBtn.addEventListener("click", cancel);

    const confirm = async () => {
      errorEl.textContent = "";
      const name = nameInput.value.trim();
      const groupName = slotSelect.value;
      if (!name) {
        errorEl.textContent = "Enter a name.";
        return;
      }
      if (!groupName) {
        errorEl.textContent = "No free pulse meter slot.";
        return;
      }
      const nameEntity = pulseMeterSlotEntity(groupName, "Add Name");
      const addEntity = pulseMeterSlotEntity(groupName, "Add");
      if (!nameEntity || !addEntity) return; // not seen yet - shouldn't happen once connected
      confirmBtn.disabled = true;
      try {
        await postRequest(`${nameEntity.namePath}/set?value=${encodeURIComponent(name)}`);
        await postRequest(`${addEntity.namePath}/press`);
        deviceAddOpen = false;
        resetForm();
        renderDeviceTableBody();
      } catch (error) {
        showRequestError(error, "Pulse meter add failed");
      } finally {
        confirmBtn.disabled = false;
      }
    };
    confirmBtn.addEventListener("click", confirm);

    // Enter = Confirm, Escape = Cancel - same pair every other editable
    // row in this table already wires (see upsertRegisteredPressureRow()'s
    // own handleEditKeydown for the original).
    const handleKeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    nameInput.addEventListener("keydown", handleKeydown);
    slotSelect.addEventListener("keydown", handleKeydown);

    return row;
  }

  // "Pulse Meter N" -> "IO N" - the label actually printed on the board
  // next to the SH1.0 pulse connector (project-docs/docs/hardware/
  // esp32-s3-rs485-can-board.md), not the internal group name.
  function pulseSlotOptionLabel(groupName) {
    const m = /^Pulse Meter (\d+)$/.exec(groupName);
    return m ? `IO ${m[1]}` : groupName;
  }

  function refreshDeviceAddRow() {
    const row = deviceAddRow;
    const free = pulseMeterGroups().filter((g) => !isPulseMeterRegistered(g));
    const freeKey = free.join(",");
    if (row._slotKey !== freeKey) {
      row._slotKey = freeKey;
      const select = row._slotSelect;
      const prevValue = select.value;
      select.innerHTML = free.map((g) => `<option value="${g}">${pulseSlotOptionLabel(g)}</option>`).join("");
      if (row._slotSelectTouched && free.includes(prevValue)) select.value = prevValue;
    }
  }

  // All three of this slot's possible sensor entities, ever - used only
  // to know which OTHER ones to clean up in syncPressureHomeCard() below
  // (the actual selection lives in pressureSlotValueLabels()).
  const PRESSURE_METRIC_LABELS = ["Pressure", "Total Consumption", "Flow Rate", "Flow Rate (L/min)"];

  function pressureSlotValueLabels(groupName) {
    const typeEntity = pressureSlotEntity(groupName, "Device Type");
    if (!typeEntity || typeEntity.value === undefined) return [];
    return typeEntity.value === "Flow" ? ["Total Consumption", "Flow Rate", "Flow Rate (L/min)"] : ["Pressure"];
  }

  function syncPressureHomeCard(groupName) {
    // Live, on every call (this slot's Device Type may have just arrived
    // or changed) - see refreshGroupIcon()'s own comment for the bug this
    // fixes. A no-op if this slot has no Home card yet/anymore.
    refreshGroupIcon(groupName);
    const addrEntity = pressureSlotEntity(groupName, "Modbus Address");
    if (!addrEntity || !(addrEntity.value > 0)) {
      const home = homeGroups.get(groupName);
      if (home) {
        home.card.remove();
        homeGroups.delete(groupName);
      }
      for (const label of PRESSURE_METRIC_LABELS) {
        const e = pressureSlotEntity(groupName, label);
        if (e) e.el = null;
      }
      return;
    }
    const activeLabels = pressureSlotValueLabels(groupName);
    for (const label of PRESSURE_METRIC_LABELS) {
      if (activeLabels.includes(label)) continue;
      const e = pressureSlotEntity(groupName, label);
      if (e && e.el) {
        e.el.remove();
        e.el = null;
      }
    }
    // Same collision signal the Service table's own badge already uses
    // (latestCollisionAddresses(), fed by the debounced "Scan
    // Collisions" CSV - see set_scan_collision_address()'s cooldown in
    // pressure_sensor.yaml) - a slot flagged here shows "--" instead of
    // whatever its last poll happened to read, see upsertHomeMetric()'s
    // own comment for why. Applies to every active metric, not just one
    // - a Flow-type slot's Total Consumption AND Flow Rate are both
    // reads from the same physically-colliding device.
    const collision = latestCollisionAddresses().includes(Math.round(addrEntity.value));
    for (const label of activeLabels) {
      const e = pressureSlotEntity(groupName, label);
      if (e) upsertHomeMetric(e, collision);
    }
  }

  function resyncDeviceHomeCardOrder() {
    const baseWeight = groupWeights.get(PULSE_METER_ANCHOR_GROUP) ?? groupWeights.get("Pulse Meter 1") ?? 10;
    let changed = false;
    orderedRegisteredDevices().forEach((d, i) => {
      const home = homeGroups.get(d.groupName);
      if (home && home.weight !== baseWeight + i) {
        home.weight = baseWeight + i;
        changed = true;
      }
    });
    if (changed) reorderHomeGroups();
  }

  function renderPressureEntity(entity) {
    if (entity.groupName === PRESSURE_ADD_GROUP) {
      ensureDeviceTable(); // make sure the toolbar + table exist even with zero scan results yet
      const label = displayName(entity);
      if (label === "Find Modbus Devices") mountPressureToolbarButton(entity);
      else if (label === "Add Result") notifyAddResult(entity);
      else if (label === "Scan Device Types") {
        // No render here - see "Scan Generation" below, the one thing
        // that actually triggers a redraw for a scan's own findings.
      } else if (label === "Scan Mismatches") {
        // Its own branch, and deliberately NOT gated on scanResultsFresh
        // or Scan Generation: a mismatch is not a scan finding, it is
        // the live poll noticing that the device at a registered address
        // is not the type the slot is configured for (see _poll_finish
        // in packages/pressure_sensor.yaml). It can therefore arrive at
        // any time, with no scan anywhere near it. This channel used to
        // fall through to the generic path below, which returns early
        // for the Add group - so the firmware could set the flag
        // correctly and the badge would only appear if something else
        // happened to redraw the table.
        renderDeviceTableBody();
      } else if (label === "Scan Results") {
        // See scanResultsFresh's own comment further up - only an update
        // arriving after the initial dump has already settled counts as
        // an actual new scan; one that arrives as part of the dump
        // itself (initialSettled still false here) is old, persisted
        // state, not a fresh result. Deliberately no render here either
        // - see "Scan Generation" below.
        if (initialSettled) scanResultsFresh = true;
      } else if (label === "Scan Collisions") {
        // Deliberately neither render nor mark scan results fresh here.
        // This CSV is shared with live polling as well as scan completion;
        // the matching generation event below identifies which producer
        // finished its update. A completed scan always publishes Scan
        // Results first, which is what marks its snapshot as fresh.
      } else if (label === "Scan Generation") {
        // Published once by the firmware, strictly AFTER Scan Results,
        // Scan Device Types and Scan Collisions for the same sweep
        // (water-telemetry-hub.yaml's modbus_scan_finish) - the single
        // trigger for redrawing the Devices table from a scan. Those
        // three still arrive as three separate SSE events, one browser
        // event-loop tick apart; rendering on each one's own arrival
        // (what this used to do, each with its own render call above)
        // could draw the table from an old scan's Results paired with a
        // brand new Collisions - or any other mismatched combination -
        // for the handful of milliseconds between them. By the time this
        // event arrives the other three are
        // guaranteed already at their new values: ESPHome delivers SSE
        // frames over one connection in the order they were written.
        renderDeviceTableBody();
      } else if (label === "Live Collision Generation") {
        // Live slot polling also owns the shared collision CSV, but does
        // not finish a scan and therefore never bumps Scan Generation.
        // Firmware publishes this barrier immediately after that CSV, so
        // badges and Home placeholders update without exposing a torn
        // scan snapshot.
        renderDeviceTableBody();
        for (const slot of registeredPressureSlots()) syncPressureHomeCard(slot.groupName);
      } else if (label === "Scan In Progress") syncScanButtonBusyState(entity.value === true);
      // Add Name / Add Target Address / Add itself have no visible UI of
      // their own - they're write-only targets set by each scan-
      // discovered new-device row's own Confirm icon above, never
      // rendered directly.
      return;
    }
    // Coalesced, not immediate: this fires for EVERY entity update in a
    // pressure/flow slot's group, and the scheduler publishes several per
    // slot per poll (rate, total, correction, exact, online), so with four
    // slots registered this path was rebuilding the whole Devices table
    // more than a dozen times a second - each rebuild re-running every
    // row's upsert and re-ordering the tbody. Rows are still refreshed
    // from the same data, just once per burst instead of once per state
    // event. User-initiated rebuilds (opening a row, adding, dismissing)
    // deliberately stay synchronous - those need the DOM updated by the
    // time the click handler returns.
    scheduleDeviceTableRender();
    syncPressureHomeCard(entity.groupName);
  }


  const PULSE_METER_RE = /^Pulse Meter \d+$/;

  function pulseMeterSlotEntity(groupName, label) {
    for (const e of entities.values()) {
      if (e.groupName === groupName && displayName(e) === label) return e;
    }
    return null;
  }

  // Both meters, in a fixed order (alphabetical happens to already be
  // the right physical order: "Pulse Meter 1" before "...2") - the
  // shared Sort Order (registeredPulseMeterSlots() above) overrides this
  // once a meter has actually been reordered; this is only the fallback/
  // discovery order (which meters exist at all, from whatever SSE dump
  // has arrived so far).
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

  function upsertRegisteredPulseMeterRow(tbody, groupName, isFirst, isLast) {
    const key = "reg:" + groupName;
    const nameEntity = pulseMeterSlotEntity(groupName, "Display Name");
    const delEntity = pulseMeterSlotEntity(groupName, "Delete");
    let row = deviceTableRows.get(key);
    if (!row) {
      row = el(
        "tr",
        "",
        `<td class="hub-pressure-name"></td><td class="hub-pressure-status"></td><td class="hub-pressure-action"></td><td class="hub-pressure-order"></td>`
      );
      deviceTableRows.set(key, row);
      tbody.appendChild(row);

      const nameCell = row.querySelector(".hub-pressure-name");
      const nameRow = el("div", "hub-pressure-name-row");
      nameCell.appendChild(nameRow);
      nameRow.appendChild(el("span", "hub-device-type-icon", svgIcon("water")));
      const nameContent = el("div", "hub-pressure-name-content");
      nameRow.appendChild(nameContent);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 32;
      nameInput.disabled = true;
      nameContent.appendChild(nameInput);
      row._nameInput = nameInput;

      const status = el("span", "hub-pressure-badge hub-pressure-badge-pending", "Idle");
      row.querySelector(".hub-pressure-status").appendChild(status);
      row._statusEl = status;

      const actionCell = row.querySelector(".hub-pressure-action");
      const editBtn = el("button", "hub-pressure-icon-btn hub-pressure-edit-btn", svgIcon("pencil"));
      editBtn.type = "button";
      editBtn.title = "Edit";
      actionCell.appendChild(editBtn);

      const delBtn = el("button", "hub-pressure-icon-btn hub-pressure-del-btn", svgIcon("trash"));
      delBtn.type = "button";
      delBtn.title = "Delete";
      actionCell.appendChild(delBtn);
      row._delBtn = delBtn;

      const saveBtn = el("button", "hub-pressure-icon-btn hub-pressure-save-btn", svgIcon("check"));
      saveBtn.type = "button";
      saveBtn.title = "Save";
      actionCell.appendChild(saveBtn);
      row._saveBtn = saveBtn; // Zero-Flow Timeout's own Enter key clicks this - see upsertPulseMeterExpandedField()

      const cancelBtn = el("button", "hub-pressure-icon-btn hub-pressure-cancel-btn", svgIcon("close"));
      cancelBtn.type = "button";
      cancelBtn.title = "Cancel";
      actionCell.appendChild(cancelBtn);

      // Up/Down - same shared cross-type ordering as the pressure rows
      // (moveDeviceRow() above), independent of the edit lock (no need to
      // press the pencil first).
      const orderGroup = el("div", "hub-pressure-order-group");
      row.querySelector(".hub-pressure-order").appendChild(orderGroup);
      const upBtn = el("button", "hub-pressure-icon-btn hub-pressure-order-btn", svgIcon("chevronUp"));
      upBtn.type = "button";
      upBtn.title = "Move up";
      upBtn.addEventListener("click", () => moveDeviceRow(groupName, -1));
      const downBtn = el("button", "hub-pressure-icon-btn hub-pressure-order-btn", svgIcon("chevronDown"));
      downBtn.type = "button";
      downBtn.title = "Move down";
      downBtn.addEventListener("click", () => moveDeviceRow(groupName, 1));
      orderGroup.append(upBtn, downBtn);
      row._upBtn = upBtn;
      row._downBtn = downBtn;

      // Built once, up front - not lazily per-entity - since Reading/
      // Update/Zero-Flow Timeout each arrive as separate, independent
      // SSE updates; building the whole skeleton here means each one
      // just fills in/wires its own already-existing input the moment it
      // shows up (upsertPulseMeterExpandedField() below), with no
      // dependency on which of the three arrives first. Not attached to
      // the DOM until actually opened (see enterEdit()/exitEdit()) - a
      // `hidden` <tr> would still count for the table's own :first-
      // child/:last-child border-rounding CSS even while invisible, so
      // it's only ever inserted while genuinely in use.
      const expandedRow = el("tr", "hub-pulsemeter-expanded");
      const expandedCell = document.createElement("td");
      expandedCell.colSpan = 4;
      expandedRow.appendChild(expandedCell);

      const readingLine = el("div", "hub-pulsemeter-expanded-field");
      const readingLabel = el("span", "hub-pulsemeter-expanded-label", "Reading");
      const readingInput = document.createElement("input");
      // text + inputmode: "decimal", NOT type="number" - Safari's native
      // number-input widget silently re-renders an assigned .value using
      // the device's own locale AND its own rounding (a full-precision
      // "0.062692" can show back as "99999,13" - comma decimal
      // separator, fewer digits, matching neither the actual value nor
      // this field's own configured step). A plain text input with a
      // decimal-hinting keyboard sidesteps that entirely - whatever this
      // file assigns to .value is exactly what's shown, full stop. All
      // validation here was already hand-rolled in JS (parseFloat, min/
      // max checks below) - never relied on the browser's own number-
      // input semantics to begin with, so nothing else changes.
      readingInput.type = "text";
      readingInput.inputMode = "decimal";
      // Own class purely so its width can be sized for what it actually
      // holds (a full-precision meter reading, e.g. "12345.123456")
      // without also widening the Modbus Address box next to it, which
      // holds at most 3 digits - see dashboard.css.
      readingInput.className = "hub-reading-input";
      const updateBtn = el("button", "hub-btn hub-btn-compact", "Update");
      updateBtn.type = "button";
      readingLine.append(readingLabel, readingInput, updateBtn);
      // Same three-state lifecycle as the pressure/flow twin - see
      // READING_CLEAN's own comment.
      row._readingState = READING_CLEAN;
      readingInput.addEventListener("input", () => {
        row._readingState = READING_DIRTY;
        row._updateSaveEnabled?.();
      });

      const zftLine = el("div", "hub-pulsemeter-expanded-field");
      const zftLabel = el("span", "hub-pulsemeter-expanded-label", "Zero-Flow Timeout");
      const zftInput = document.createElement("input");
      zftInput.type = "number";
      zftInput.className = "hub-zft-input";
      const zftUnit = el("span", "hub-pulsemeter-expanded-unit", "s");
      zftLine.append(zftLabel, zftInput, zftUnit);

      expandedCell.append(readingLine, zftLine);
      row._expandedRow = expandedRow;
      row._readingInput = readingInput;
      row._updateBtn = updateBtn;
      row._zftInput = zftInput;

      // Whether Save has anything at all to send - Name changed from
      // what editing started with, Zero-Flow Timeout typed to something
      // different from its live value, or Reading actually typed into
      // (see READING_DIRTY - it does not itself re-check against the
      // live value, so retyping the exact original reading still counts
      // as "changed"; matching Reading's own existing Update-button
      // behavior, not a new inconsistency). Re-run on every keystroke in
      // any of the three fields - see their own `input` listeners -
      // rather than only at Save time, so the checkmark greys out again
      // the moment a person types a value back to what it already was.
      const updateSaveEnabled = () => {
        const zftEntity = pulseMeterSlotEntity(groupName, "Zero-Flow Timeout");
        const nameChanged = nameInput.value !== row._editOrigName;
        const zftChanged = !!zftEntity && row._zftInput.value !== String(zftEntity.value ?? "");
        const readingChanged = row._readingState === READING_DIRTY;
        saveBtn.disabled = !(nameChanged || zftChanged || readingChanged);
      };
      row._updateSaveEnabled = updateSaveEnabled;
      nameInput.addEventListener("input", updateSaveEnabled);

      const enterEdit = () => {
        // Only one row editable at a time, table-wide, across BOTH
        // device types (deviceEditingRow, shared with the pressure
        // rows) - opening this one force-cancels/closes whichever other
        // row was already open, discarding any unsaved name edit there
        // too (same as if its own Cancel had been pressed). Also closes
        // the Add row if it's open - see the pressure row's own
        // enterEdit() comment.
        if (deviceEditingRow && deviceEditingRow !== row && deviceEditingRow._cancelEdit) {
          deviceEditingRow._cancelEdit();
        }
        closeDeviceAddRow();
        deviceEditingRow = row;
        row._editOrigName = nameInput.value;
        row._readingPending = 0;
        row._readingState = READING_CLEAN;
        row._zftDirty = false;
        nameInput.disabled = false;
        row.classList.add("hub-pressure-row-editing");
        row._editing = true;
        tbody.insertBefore(expandedRow, row.nextSibling);
        nameInput.focus();
        nameInput.select();
        updateSaveEnabled(); // nothing typed yet - starts disabled
      };
      const exitEdit = () => {
        nameInput.disabled = true;
        row.classList.remove("hub-pressure-row-editing");
        row._editing = false;
        row._readingPending = 0;
        row._readingState = READING_CLEAN;
        if (expandedRow.isConnected) expandedRow.remove();
        if (deviceEditingRow === row) deviceEditingRow = null;
        const totalConsumptionEntity = pulseMeterSlotEntity(groupName, "Total Consumption");
        row._readingInput.value = totalConsumptionEntity ? fmtValue(totalConsumptionEntity) : "";
        const zftEntity = pulseMeterSlotEntity(groupName, "Zero-Flow Timeout");
        if (zftEntity) row._zftInput.value = zftEntity.value ?? "";
        row._zftDirty = false;
        saveBtn.disabled = true;
      };
      const cancelEdit = () => {
        nameInput.value = row._editOrigName;
        exitEdit();
      };
      row._cancelEdit = cancelEdit;
      editBtn.addEventListener("click", enterEdit);
      cancelBtn.addEventListener("click", cancelEdit);
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
      saveBtn.addEventListener("click", async () => {
        if (!nameInput.value.trim()) {
          alert("Name can't be empty.");
          return; // stay in edit mode so it can be fixed
        }
        const ne = pulseMeterSlotEntity(groupName, "Display Name");
        if (!ne) return;
        // Zero-Flow Timeout is a draft, same as Reading - it only ever
        // reaches the device from here, batched with Name into the one
        // Save press, never on its own lostfocus. Validated
        // here rather than reverted silently on blur: an invalid typed
        // value stays visible and explained, same as every other field
        // in this row that commits through Save/Update instead of
        // applying itself.
        const zftEntity = pulseMeterSlotEntity(groupName, "Zero-Flow Timeout");
        let zftValue = null;
        if (row._zftDirty && zftEntity) {
          const parsed = parseFloat(row._zftInput.value);
          const outOfRange =
            Number.isNaN(parsed) ||
            (zftEntity.min !== undefined && parsed < zftEntity.min) ||
            (zftEntity.max !== undefined && parsed > zftEntity.max);
          if (outOfRange) {
            const range =
              zftEntity.min !== undefined && zftEntity.max !== undefined
                ? ` between ${zftEntity.min} and ${zftEntity.max}${zftEntity.uom ? " " + zftEntity.uom : ""}`
                : "";
            alert(`Zero-Flow Timeout must be a number${range}.`);
            return; // stay in edit mode so it can be fixed
          }
          zftValue = row._zftInput.value;
        }
        saveBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
          // Reading is now committed here too, not only through its own
          // Update button (which stays as a convenience shortcut for
          // Reading alone) - Save is the one place everything in this
          // row (Name, Zero-Flow Timeout, Reading) actually commits
          // from. Only touched when it was actually typed into
          // (READING_DIRTY): applyTypedReading() carries its own
          // validation and its own "this overwrites the accumulated
          // total" confirmation, unchanged - a "no" there cancels the
          // WHOLE Save (nothing else in the row is sent either), so a
          // declined reading change never quietly saves a name change
          // alongside it.
          if (row._readingState === READING_DIRTY) {
            const applied = await applyTypedReading({
              groupName,
              input: row._readingInput,
              button: row._updateBtn,
              row,
            });
            if (!applied) return; // stays in edit mode; applyTypedReading already left the field truthful
          }
          const requests = [postRequest(`${ne.namePath}/set?value=${encodeURIComponent(nameInput.value)}`)];
          if (zftEntity && zftValue !== null) {
            requests.push(postRequest(`${zftEntity.namePath}/set?value=${encodeURIComponent(zftValue)}`));
          }
          await Promise.all(requests);
          exitEdit();
        } catch (error) {
          showRequestError(error, "Pulse meter update failed");
        } finally {
          cancelBtn.disabled = false;
          // Not a blind re-enable: exitEdit() already set Save disabled
          // (and left edit mode) on success, and must stay that way - so
          // this only recomputes it, from whatever is actually still
          // dirty, when still in edit mode (a declined/failed step
          // above returned early without exiting).
          if (row._editing) updateSaveEnabled();
        }
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
    row._upBtn.disabled = !!isFirst;
    row._downBtn.disabled = !!isLast;
  }

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
  // Wires Reading/Update/Zero-Flow Timeout into the pre-built inputs on
  // this meter's own table row (upsertRegisteredPulseMeterRow()'s own
  // comment explains why they're built once, up front, not lazily
  // here) - each entity just fills in/wires its own already-existing
  // input the moment its own update arrives, independent of whether the
  // *other* two have shown up yet. No-op if the row doesn't exist yet
  // (shouldn't happen once Registered, but defensive).
  function upsertPulseMeterExpandedField(entity, label) {
    const row = deviceTableRows.get("reg:" + entity.groupName);
    if (!row || !row._expandedRow) return;
    if (label === "Reading") {
      const input = row._readingInput;
      if (entity.min !== undefined) input.min = entity.min;
      if (entity.max !== undefined) input.max = entity.max;
      if (entity.step !== undefined) input.step = entity.step;
      const liveEntity = () => pulseMeterSlotEntity(entity.groupName, "Total Consumption");
      if (!row._readingWired) {
        // No `change`/blur correction here either - see the identical
        // note in upsertRegisteredPressureRow() for why one used to be
        // here and what it broke.
        // Enter = Update (with its own confirm dialog, same as a mouse
        // click there - see that button's own handler just below), NOT
        // "Save the whole row" the way Name's Enter works - typing
        // Enter here should not overwrite consumption the same way a
        // plain field commit would elsewhere in the row.
        // Escape = the same whole-row Cancel every other field in this
        // table already uses, discarding any uncommitted typed value
        // (reverts to Total Consumption on the very next render either
        // way, per the fix above, but this also closes the row).
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            row._updateBtn.click();
          } else if (e.key === "Escape") {
            e.preventDefault();
            row._cancelEdit();
          }
        });
        row._readingWired = true;
      }
      // Same guard as the pressure/flow twin - see readingFieldIsIdle().
      if (readingFieldIsIdle(row)) {
        const live = liveEntity();
        input.value = live ? fmtValue(live) : "";
      }
    } else if (label === "Update") {
      if (!row._updateWired) {
        // Exactly the same call as the pressure/flow twin makes - see
        // applyTypedReading()'s own comment for why this is one shared
        // function now and not two near-identical handlers.
        row._updateBtn.addEventListener("click", async () => {
          await applyTypedReading({
            groupName: entity.groupName,
            input: row._readingInput,
            button: row._updateBtn,
            row,
          });
        });
        row._updateWired = true;
      }
    } else if (label === "Zero-Flow Timeout") {
      const input = row._zftInput;
      if (entity.min !== undefined) input.min = entity.min;
      if (entity.max !== undefined) input.max = entity.max;
      if (entity.step !== undefined) input.step = entity.step;
      if (!row._zftWired) {
        // No apply-on-blur/change at all, and no confirm() dialog either -
        // no POST until the row's own Save checkmark is actually
        // clicked, no message needed before then. A typed value is a
        // draft, exactly like
        // Reading's own field - it only ever leaves the browser when the
        // row's Save button sends it, batched with Name (see that
        // button's own handler below). _zftDirty is what stops the next
        // live-entity update from clobbering an unsaved draft, and what
        // tells Save there is something here worth sending.
        input.addEventListener("input", () => {
          row._zftDirty = true;
          row._updateSaveEnabled?.();
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            row._saveBtn.click();
          } else if (e.key === "Escape") {
            e.preventDefault();
            row._cancelEdit();
          }
        });
        row._zftWired = true;
      }
      if (!row._zftDirty && document.activeElement !== input) input.value = entity.value ?? "";
    }
  }

  // Total Consumption/Flow Rate (Home page) and Total Pulses
  // (Diagnostics) only ever render once Registered - falls through to
  // the exact same generic dispatch every other entity in this file goes
  // through otherwise. Reading/Update/Zero-Flow Timeout are intercepted
  // first, into the table row's own inline detail area instead (see
  // upsertPulseMeterExpandedField() above) - they no longer have a
  // separate Service-page section at all. Split out from
  // renderPulseMeterEntity() below so it can also be called directly to
  // "catch up" entities whose own update already arrived and was skipped
  // before Registered was known - see that function's own comment for
  // why that's needed at all.
  // Per-group timers for flashPulseMeterActivity() below - one pending
  // timeout at a time per meter, restarted (not stacked) on every new
  // pulse so a burst of fast pulses keeps the ring lit continuously
  // instead of flickering off between them.
  const pulseFlashTimers = new Map();
  const lastSeenTotalPulses = new Map();

  function flashPulseMeterActivity(groupName) {
    const row = deviceTableRows.get("reg:" + groupName);
    const home = homeGroups.get(groupName);
    const badges = [row && row._statusEl, home && home.statusEl].filter(Boolean);
    if (!badges.length) return;

    // Removing the class and forcing layout restarts the animation when
    // pulses arrive faster than its 600 ms duration.
    for (const badge of badges) badge.classList.remove("hub-pulse-flash");
    void badges[0].offsetWidth;
    for (const badge of badges) badge.classList.add("hub-pulse-flash");
    clearTimeout(pulseFlashTimers.get(groupName));
    pulseFlashTimers.set(
      groupName,
      setTimeout(() => {
        for (const badge of badges) badge.classList.remove("hub-pulse-flash");
      }, 600)
    );
  }

  // Drives the registered row's own status badge (see
  // upsertRegisteredPulseMeterRow()'s comment above for the full
  // reasoning) off "Pulse Rate"'s own value - already the exact signal
  // water_meter.yaml's zero-flow watchdog itself zeroes back out once
  // Zero-Flow Timeout elapses since the last pulse (see that field's own
  // comment there), so no new backend entity was needed for this: a
  // nonzero Pulse Rate means water is actively flowing right now, zero
  // means either it never has (a freshly added meter) or the watchdog
  // just zeroed it back out - both read the same, honest way, as "Idle".
  function updatePulseMeterStatus(groupName, pulseRate) {
    const row = deviceTableRows.get("reg:" + groupName);
    if (!row || !row._statusEl) return;
    const flowing = typeof pulseRate === "number" && pulseRate > 0;
    const text = flowing ? "Flowing" : "Idle";
    row._statusEl.textContent = text;
    row._statusEl.classList.toggle("hub-pressure-badge-ok", flowing);
    row._statusEl.classList.toggle("hub-pressure-badge-pending", !flowing);
    updateHomeCardStatus(groupName, text, flowing ? "hub-pressure-badge-ok" : "hub-pressure-badge-pending");
  }

  const HIDDEN_FROM_PULSE_DIAG = new Set(["Pulse Rate", "Total Pulses", "Sort Order"]);

  function renderPulseMeterCalibrationEntity(entity) {
    if (!isPulseMeterRegistered(entity.groupName)) return;
    const label = displayName(entity);
    if (label === "Total Pulses" && lastSeenTotalPulses.get(entity.groupName) !== entity.value) {
      lastSeenTotalPulses.set(entity.groupName, entity.value);
      flashPulseMeterActivity(entity.groupName);
    }
    if (label === "Pulse Rate") updatePulseMeterStatus(entity.groupName, entity.value); // side effect only, same reasoning
    if (label === "Reading" || label === "Update" || label === "Zero-Flow Timeout") {
      upsertPulseMeterExpandedField(entity, label);
      return;
    }
    if (HIDDEN_FROM_PULSE_DIAG.has(label)) return;
    const page = pageFor(entity);
    if (page === "home") upsertHomeMetric(entity);
    else if (page === "diagnostics") upsertDiagRow(entity);
  }

  function renderPulseMeterEntity(entity) {
    const groupName = entity.groupName;
    const label = displayName(entity);
    if (label === "Display Name") {
      groupDisplayNames.set(groupName, (entity.value || "").trim());
      applyGroupLabel(groupName);
    }
    if (label === "Registered" || label === "Delete" || label === "Display Name" || label === "Sort Order") {
      renderDeviceTableBody();
      syncPulseMeterVisibility(groupName);
    }
    if (isPulseMeterRegistered(groupName)) {
      for (const e of entities.values()) {
        if (e.groupName === groupName) renderPulseMeterCalibrationEntity(e);
      }
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

  // ensureGroupFn: defaults to the Devices page (ensureServiceGroup) -
  // pass ensureDiagGroup instead to render on the System page (used by
  // any group that belongs with the System-page readouts/actions rather
  // than a per-device card - see upsertServiceText()/upsertServiceSwitch()
  // below, same parameter for the same reason).
  function upsertServiceNumber(entity, ensureGroupFn = ensureServiceGroup) {
    const group = ensureGroupFn(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.el) {
      entity.el = el(
        "div",
        "hub-field",
        `<div class="label"><span class="label-text"></span></div><div class="hub-field-row"></div><div class="hub-hint"></div>`
      );
      const row = entity.el.querySelector(".hub-field-row");
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
        // separate "apply" step, unlike Reading/Update), so those
        // specifically get a confirmation before the change goes out.
        if (CONFIRM_ON_CHANGE.has(displayName(entity))) {
          const message = `Change ${entity.groupName} ${displayName(entity)} to ${input.value}${entity.uom ? " " + entity.uom : ""}?`;
          if (!confirm(message)) {
            input.value = entity.value ?? ""; // revert the visible value to the last known server state
            return;
          }
        }
        postRequest(`${entity.namePath}/set?value=${encodeURIComponent(input.value)}`).catch((error) =>
          showRequestError(error, `${displayName(entity)} update failed`)
        );
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
    const hint = entity.el.querySelector(".hub-hint");
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
      if (sibling) mountComboButton(sibling, entity.el.querySelector(".hub-field-row"));
    }
    entity.el.dataset.weight = entity.groupWeight ?? 500;
    reorderServiceFields(group);
  }

  // Display Name - a plain text field, styled like a number field
  // but with no min/max hint and no confirm-on-change (purely cosmetic,
  // nothing to protect against). Renaming immediately relabels this
  // meter's Home card and Service/Diagnostics section headers.
  function upsertServiceText(entity, ensureGroupFn = ensureServiceGroup) {
    const group = ensureGroupFn(entity.groupName ?? FALLBACK_GROUP);
    const label = displayName(entity);
    if (!entity.el) {
      entity.el = el(
        "div",
        "hub-field",
        `<div class="label"><span class="label-text"></span></div><div class="hub-field-row"></div>`
      );
      const row = entity.el.querySelector(".hub-field-row");
      const input = document.createElement("input");
      input.type = "text";
      row.appendChild(input);
      input.addEventListener("change", () => {
        postRequest(`${entity.namePath}/set?value=${encodeURIComponent(input.value)}`).catch((error) =>
          showRequestError(error, `${displayName(entity)} update failed`)
        );
      });
      entity.inputEl = input;
      group.fields.appendChild(entity.el);
    }
    if (entity.maxLength !== undefined) entity.inputEl.maxLength = entity.maxLength;
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

  function upsertServiceSwitch(entity, ensureGroupFn = ensureServiceGroup) {
    const group = ensureGroupFn(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.el) {
      entity.el = el(
        "div",
        "hub-field",
        `<div class="label"><span class="label-text"></span></div><div class="hub-field-row"></div>`
      );
      const toggle = el("button", "hub-toggle", "");
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.addEventListener("click", () => {
        postRequest(`${entity.namePath}/toggle`).catch((error) => showRequestError(error, `${displayName(entity)} update failed`));
      });
      entity.el.querySelector(".hub-field-row").appendChild(toggle);
      entity.toggleEl = toggle;
      group.fields.appendChild(entity.el);
    }
    const label = displayName(entity);
    entity.el.querySelector(".label-text").textContent = label;
    attachHelp(entity.el.querySelector(".label"), HELP_TEXT[label]);
    const on = entity.value === true;
    entity.toggleEl.classList.toggle("hub-toggle-on", on);
    entity.toggleEl.setAttribute("aria-checked", on ? "true" : "false");
    entity.el.dataset.weight = entity.groupWeight ?? 500;
    reorderServiceFields(group);
  }

  // Moves (or lazily creates) a paired Update button into a Reading
  // field's own row, relabelled "Update" regardless of its full entity
  // name - adjacency to the field already says what it updates, clearer
  // than a longer label like "<Meter> Sync" would be on its own.
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
    buttonEntity.btnEl.className = "hub-btn hub-btn-compact";
    buttonEntity.btnEl.textContent = "Update";
    if (buttonEntity.btnEl.parentElement !== row) row.appendChild(buttonEntity.btnEl);
    attachHelp(row, HELP_TEXT["Update"]);
    if (buttonEntity.el) {
      buttonEntity.el.remove();
      buttonEntity.el = null;
    }
  }

  async function pressButton(entity) {
    const label = displayName(entity);
    if (CONFIRM_ON_PRESS.has(label) && !confirm(confirmMessageForPress(entity, label))) return;
    const btn = entity.btnEl;
    btn.classList.add("hub-pressed");
    try {
      await postRequest(`${entity.namePath}/press`);
    } catch (error) {
      showRequestError(error, `${label} failed`);
    } finally {
      setTimeout(() => btn.classList.remove("hub-pressed"), 400);
    }
  }

  // Update's confirmation names the actual value about to be applied
  // (read straight off the paired Reading field's input) rather than a
  // generic "are you sure?" - Reboot Device just needs a plain yes/no.
  function confirmMessageForPress(entity, label) {
    if (label === "Reboot Device") return "Reboot the device now?";
    if (label === "Forget Wi-Fi")
      return "Forget the current Wi-Fi network and restart into setup mode? Calibration and other settings are kept - only the network changes.";
    if (label === "Reset Correction") {
      const offsetEntity = pressureSlotEntity(entity.groupName, "Correction Offset");
      const v = offsetEntity && typeof offsetEntity.value === "number" ? offsetEntity.value : 0;
      const shown = offsetEntity ? fmtValue(offsetEntity) : "0";
      const unit = offsetEntity && offsetEntity.uom ? ` ${offsetEntity.uom}` : "";
      return `Clear the ${v > 0 ? "+" : ""}${shown}${unit} correction and go back to showing the meter's own raw reading? The meter itself is never touched either way.`;
    }
    if (label === "Delete" && isPressureGroup(entity.groupName)) {
      const nameEntity = pressureSlotEntity(entity.groupName, "Display Name");
      const addrEntity = pressureSlotEntity(entity.groupName, "Modbus Address");
      const shownName =
        (nameEntity && nameEntity.value && nameEntity.value.trim()) ||
        (addrEntity ? `address ${Math.round(addrEntity.value)}` : "this sensor");
      return `Delete "${shownName}"'s registration? Its Dashboard card disappears until re-added.`;
    }
    if (label === "Delete" && PULSE_METER_RE.test(entity.groupName)) {
      // Unlike a pressure slot's Delete, a water meter's own raw group
      // name ("Pulse Meter 1") is a perfectly reasonable fallback here -
      // it's not an internal/meaningless id the way a pressure slot's is
      // (see the branch above), a water meter's identity is permanently
      // tied to its own physical GPIO.
      //
      // The firmware's Delete zeroes the pulse count AND the calibration
      // offset (water_meter.yaml), by design - not just the registration
      // flag, so re-adding it later starts from nothing, not from where
      // it left off. The dialog says that plainly, because it is not
      // undoable.
      const nameEntity = pulseMeterSlotEntity(entity.groupName, "Display Name");
      const shownName = (nameEntity && nameEntity.value && nameEntity.value.trim()) || entity.groupName;
      return `Delete "${shownName}"? Its accumulated Total Consumption and pulse count are reset to zero and cannot be recovered - re-adding it later starts from nothing, not from where it left off.`;
    }
    return "Are you sure?";
  }

  function upsertServiceButton(entity) {
    const base = comboBaseKey(entity.id);
    if (base) {
      const numberEntity = entities.get(`number-${base}_reading`);
      if (numberEntity && numberEntity.el) {
        mountComboButton(entity, numberEntity.el.querySelector(".hub-field-row"));
        return;
      }
      // Reading field hasn't rendered yet - fall through to a standalone
      // button for now; upsertServiceNumber() will absorb it once it does.
    }
    const group = ensureServiceGroup(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.btnEl) {
      entity.el = el("div", "hub-field");
      const row = el("div", "hub-field-row");
      entity.btnEl = el("button", "hub-btn", entity.name);
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
    const pre = document.getElementById("hub-log");
    const stickToBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    const row = document.createElement("div");
    row.textContent = raw.replace(ANSI_ESCAPE_RE, "");
    pre.appendChild(row);
    while (pre.childElementCount > LOG_MAX_LINES) pre.removeChild(pre.firstChild);
    if (stickToBottom) pre.scrollTop = pre.scrollHeight;
  }

  // "Debug Log: Modbus" (water-telemetry-hub.yaml) - flips the "modbus" log
  // tag (include/rs485_modbus.h) up to VERY_VERBOSE via ESPHome's own
  // logger.set_level action, right from the Log page itself rather than
  // as a generic Service-page switch - this only ever matters while
  // actually watching this page for a live communication problem, so
  // that's where the control belongs. Off by default (see the entity's
  // own restore_mode: ALWAYS_OFF) - at VERY_VERBOSE a single bus scan
  // alone logs ~250 lines, not something to leave running.
  function mountLogDebugToggle(entity) {
    const toolbar = document.getElementById("hub-log-toolbar");
    if (!entity.toggleEl) {
      const wrap = el("label", "hub-log-debug-toggle", `<span>Debug: Modbus</span>`);
      const toggle = el("button", "hub-toggle", "");
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.addEventListener("click", () => {
        postRequest(`${entity.namePath}/toggle`).catch((error) => showRequestError(error, "Modbus debug toggle failed"));
      });
      wrap.appendChild(toggle);
      toolbar.insertBefore(wrap, document.getElementById("hub-log-clear"));
      entity.toggleEl = toggle;
    }
    const on = entity.value === true;
    entity.toggleEl.classList.toggle("hub-toggle-on", on);
    entity.toggleEl.setAttribute("aria-checked", on ? "true" : "false");
  }

  // --- Shared helpers ------------------------------------------------

  async function postRequest(path) {
    const response = await fetch(path, { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    return response;
  }

  function showRequestError(error, context = "Request failed") {
    console.error(context, error);
    alert(`${context}. ${error && error.message ? error.message : "Check the device connection and try again."}`);
  }

  // Entity names repeat their sorting_group's name as a prefix (e.g.
  // "Main Meter Reading" in the "Main Meter" group) so the raw HA/API
  // name stays self-explanatory - but on the dashboard, the surrounding
  // card/section header already says that, so drop the repeat here.
  // ESPHome rewrites "/" inside an entity NAME to the look-alike U+2044
  // FRACTION SLASH - its REST and SSE paths are built out of names, so a
  // real slash there would split the path. unit_of_measurement keeps its
  // ordinary slash. Undoing the substitution here, once, means every
  // label comparison and every label shown in this file works with the
  // name as it was actually written ("Flow Rate (L/min)"), and the
  // fraction slash stays what it is: a transport detail.
  const FRACTION_SLASH = /\u2044/g;

  function displayName(entity) {
    const g = entity.groupName;
    const name = entity.name.replace(FRACTION_SLASH, "/");
    if (g && name.startsWith(g + " ")) return name.slice(g.length + 1);
    return name;
  }

  // Adds a tap-to-reveal "?" to `container` (typically a `.label`/row
  // element) and a hidden explanation block right after it - a
  // no-op if there's no text for this label, or if it's already been
  // attached (upsert* runs on every SSE update, this only needs to
  // happen once).
  function attachHelp(container, text) {
    if (!text || container.querySelector(".hub-help-btn")) return;
    const btn = el("button", "hub-help-btn", "?");
    btn.type = "button";
    btn.setAttribute("aria-label", "Help");
    const hint = el("div", "hub-help-text", text);
    hint.hidden = true;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      hint.hidden = !hint.hidden;
    });
    container.appendChild(btn);
    container.insertAdjacentElement("afterend", hint);
  }

  // How many decimals a `step` actually permits - 0.001 -> 3, 0.5 -> 1,
  // 1 -> 0. Read off the step's own decimal string rather than computed
  // with log10, which would trip over float representation (0.001 is not
  // exactly 0.001 in binary).
  function decimalsOfStep(step) {
    const s = String(step);
    if (s.includes("e") || s.includes("E")) {
      // e.g. "1e-6" - exponent form, the magnitude is the decimal count
      const exp = Number(s.split(/[eE]/)[1]);
      return exp < 0 ? -exp : 0;
    }
    const frac = s.split(".")[1];
    return frac ? frac.replace(/0+$/, "").length : 0;
  }

  // Rejects a typed Reading finer than the meter can actually measure,
  // instead of accepting it and quietly rounding to whatever the nearest
  // representable value happens to be: entering 12345.000001 on a meter
  // that counts whole liters would otherwise silently become
  // 12345.000000, which looks like the app losing data when it's really
  // the input promising precision the instrument doesn't have.
  //
  // Driven entirely by the entity's own `step` (which arrives in its SSE
  // payload straight from each meter package's own number: definition),
  // so a meter with a different pulse size or a device that genuinely
  // reports finer values - the T3-1-2-H flow meter reports to the
  // milliliter, step 0.000001 - is validated against its own resolution
  // with no special-casing here. Returns null when the value is fine, or
  // a ready-to-show message when it isn't.
  //
  // Checks the *typed* decimals rather than the parsed number, because
  // the parsed number has already lost the distinction: 12345.000001
  // parses to a float that is indistinguishable from 12345. The grid
  // check below additionally covers steps that aren't a power of ten
  // (0.5, 0.25, ...), which no meter in this project uses today but
  // which the same code should not silently mishandle if one ever does.
  function readingStepViolation(typed, entity) {
    const step = entity && entity.step;
    if (!(step > 0)) return null;
    const decimals = decimalsOfStep(step);
    const uom = entity.uom ? ` ${entity.uom}` : "";
    const typedFrac = (String(typed).trim().split(/[.,]/)[1] || "").replace(/0+$/, "");
    if (typedFrac.length > decimals) {
      return `This meter's resolution is ${step}${uom}, so Reading takes at most ${decimals} decimal${decimals === 1 ? "" : "s"} - "${String(typed).trim()}" is finer than it can measure.`;
    }
    const scale = Math.pow(10, decimals);
    const scaledValue = Math.round(parseDecimalInput(typed) * scale);
    const scaledStep = Math.round(step * scale);
    if (scaledStep > 0 && scaledValue % scaledStep !== 0) {
      return `This meter measures in steps of ${step}${uom}, so Reading has to be a multiple of it.`;
    }
    return null;
  }

  // parseFloat() doesn't understand a decimal comma ("12345,123456") - it
  // silently stops at the comma, so a Hungarian-locale-typed Reading
  // value would parse as just its integer part, and Update would apply
  // that truncated number without any warning (worse: it's exactly the
  // kind of "looks like it worked" failure a measuring instrument can
  // never be allowed to have). Reading fields are plain text inputs
  // (Safari's own number-input widget has a *different* locale-
  // formatting bug), taking whatever the user's own keyboard/locale
  // naturally produces, so this file has to parse it itself rather than
  // leaning on either the browser's own number-input parsing or a
  // locale-naive parseFloat().
  // A single comma is always treated as a decimal separator here (never
  // a thousands separator) - these fields are typed free-form, not
  // formatted-as-you-type, so there's no ambiguity to resolve.
  // --- Applying a Reading --------------------------------------------------
  // ONE implementation, used by both device-table row builders. The
  // pressure/flow rows and the pulse meter rows are near-duplicates of
  // each other, and fixing this logic in one without the other risks
  // shipping the same bug twice, once per twin. There is nothing
  // type-specific left here, so there is no longer a second copy to
  // forget.
  const UPDATE_REFUSAL = {
    invalid: "The device couldn't read that as a plain decimal number. Enter digits and at most one decimal separator, e.g. 12345.678.",
    range: "That reading is outside the range this meter accepts.",
    resolution: "That reading is finer than this meter can measure, so it can't be set to it. Round it to the meter's own resolution and try again.",
    no_reading: "This meter hasn't been read successfully yet, so there's no reading to correct against. Wait for it to show a live value, then try again.",
    stale: "This meter hasn't answered in a while, so its last reading may already be out of date. Check that it's online, then try again.",
    wrong_type: "This slot isn't set up as a flow meter, so it has no total to correct.",
  };

  // Reading field lifecycle.
  //
  // A "dirty" boolean wasn't enough. It covers "someone has typed
  // something", but not the window between sending an Update and
  // learning what the device did with it, where the field holds a value
  // that is neither a draft nor confirmed - and a render path that
  // treats that as fair game can flash the old reading back: the device
  // publishes its new numeric total BEFORE the exact-millilitre channel
  // this dashboard actually renders from, so a render landing in that
  // gap redraws the field from a stale exact value for a moment, right
  // after a successful update.
  //
  // Three states, and the rule is simply that only CLEAN may be
  // refreshed from live state:
  //   clean   - showing the live reading; render freely
  //   dirty   - typed, not applied; the draft is the user's
  //   pending  - applied, waiting for this request's own verdict
  // PENDING ends only on the authoritative result for THAT request (see
  // watchUpdateResult), or on a timeout, so it can never wedge.
  const READING_CLEAN = "clean";
  const READING_DIRTY = "dirty";
  const READING_PENDING = "pending";

  function readingFieldIsIdle(row) {
    return !row || (row._readingState ?? READING_CLEAN) === READING_CLEAN;
  }

  // Identifies which update a Reading field is waiting on - see
  // applyTypedReading()'s own comment for why an update that nobody is
  // waiting for any more must not write to the field.
  let readingRequestSequence = 0;

  // Waiters on the shared "Device Update Result" channel
  // (water-telemetry-hub.yaml). An HTTP 200 from the POST below only means
  // the device received the request - whether it applied it comes back
  // here, so a refusal is shown to the person who asked rather than
  // silently looking like success.
  const updateResultWaiters = new Set();

  // "<sequence>|<device>|<status>|<request>". The request is user-typed
  // and may itself contain a "|", so everything after the third
  // separator is taken verbatim - see volume::publish_update_result()
  // (include/volume.h) for the matching split on the device side.
  function notifyUpdateResult(entity) {
    const parts = (typeof entity.value === "string" ? entity.value : "").split("|");
    if (parts.length < 4) return;
    const result = { sequence: parts[0], device: parts[1], status: parts[2], request: parts.slice(3).join("|") };
    for (const waiter of [...updateResultWaiters]) waiter(result);
  }

  // Resolves with the outcome of OUR request, not merely the next
  // outcome for this device. Two browser tabs can have updates in flight
  // against the same meter at once, and matching on the device alone
  // meant one tab could report the other tab's refusal as its own -
  // showing a failure that never happened and putting the wrong value
  // back on screen. The device echoes the request string back for
  // exactly this. Two clients that sent the identical string are
  // indistinguishable, but then the outcome is the same for both.
  function watchUpdateResult(deviceName, requestText) {
    let settle = null;
    let timer = null;
    const finish = (result) => {
      if (!settle) return;
      updateResultWaiters.delete(listener);
      clearTimeout(timer);
      const resolve = settle;
      settle = null;
      resolve(result);
    };
    const listener = (result) => {
      if (result.device === deviceName && result.request === requestText) finish(result);
    };
    const promise = new Promise((resolve) => {
      settle = resolve;
      updateResultWaiters.add(listener);
      // A device that never reports back (an SSE hiccup, a firmware
      // older than the echo) resolves as null rather than leaving the
      // field pending forever - treated as "outcome unknown", which
      // hands the field back to live state rather than claiming either
      // success or failure.
      timer = setTimeout(() => finish(null), 4000);
    });
    return { promise, cancel: () => finish(null) };
  }

  // The exact millilitre value of a typed reading, or null if it isn't a
  // plain decimal number / is finer than a millilitre. Mirrors
  // volume::parse_m3_to_ml() (include/volume.h) exactly, including its
  // refusals - the device applies its own copy of this rule, this one
  // exists so the optimistic local update below lands on precisely the
  // same integer the device just stored.
  function parseM3ToMl(text) {
    const match = /^([+-]?)(\d+)(?:[.,](\d{1,6}))?$/.exec(String(text).trim());
    if (!match) return null;
    const frac = (match[3] || "").padEnd(6, "0");
    const ml = BigInt(match[2]) * 1000000n + BigInt(frac);
    return match[1] === "-" ? -ml : ml;
  }

  // `row` and `input` are the table row and its Reading field. Refusals
  // have to leave the row in a truthful state, and which state that is
  // depends on who refused:
  //   - the user mistyped        -> the draft stays, so it can be fixed
  //   - the device said no       -> the live reading comes back, because
  //                                 leaving a rejected number on screen is
  //                                 the "looks like it worked" failure
  //                                 this whole rework exists to remove
  //   - nobody answered          -> the live reading comes back too; we
  //                                 don't know, so we don't claim
  async function applyTypedReading({ groupName, input, button, row }) {
    // Every update carries a token, and only the update the field is
    // currently waiting on may write to it. Without this, a request the
    // user has already moved on from - one whose result never arrived
    // and which is sitting out its timeout - comes back seconds later
    // and overwrites whatever is being typed by then. Found while
    // writing the regression tests for the change-handler bug: a stale
    // update from an earlier interaction wiped a fresh draft mid-typing,
    // which is the same class of bug in a slower disguise.
    const token = ++readingRequestSequence;
    const stillOurs = () => !row || row._readingPending === token;
    const setState = (state) => {
      if (row) row._readingState = state;
    };
    const revertToLiveReading = () => {
      if (!stillOurs()) return;
      const live = groupEntity(groupName, "Total Consumption");
      setState(READING_CLEAN);
      input.value = live ? fmtValue(live) : "";
    };
    const keepDraft = () => {
      if (row) row._readingPending = 0;
      setState(READING_DIRTY);
    };

    const readingEntity = groupEntity(groupName, "Reading");
    const updateEntity = groupEntity(groupName, "Update");
    if (!readingEntity || !updateEntity) {
      alert("This device isn't ready to accept a reading yet - give it a moment, then try again.");
      keepDraft();
      return false;
    }
    // Everything below is validated against THIS entity's own metadata -
    // its min, its max, its step - never a constant or another meter's.
    // A pulse meter counting whole litres and a flow meter reporting
    // millilitres have genuinely different limits, and a message quoting
    // the wrong one is worse than none.
    const typed = String(input.value).trim();
    const value = parseDecimalInput(typed);
    const uom = readingEntity.uom ? ` ${readingEntity.uom}` : "";
    if (Number.isNaN(value)) {
      alert(UPDATE_REFUSAL.invalid);
      keepDraft();
      return false;
    }
    if (
      (readingEntity.min !== undefined && value < readingEntity.min) ||
      (readingEntity.max !== undefined && value > readingEntity.max)
    ) {
      alert(`Reading has to be between ${readingEntity.min}${uom} and ${readingEntity.max}${uom}.`);
      keepDraft();
      return false;
    }
    // Resolution check before anything is sent - see
    // readingStepViolation()'s own comment for why a too-precise value
    // has to be refused here rather than silently rounded. The device
    // enforces the same rule itself; this one is here to explain it
    // before a round trip, not instead of it.
    const stepProblem = readingStepViolation(typed, readingEntity);
    if (stepProblem) {
      alert(stepProblem);
      keepDraft();
      return false;
    }
    // groupLabel() is "" for an unnamed pressure slot - fall back to the
    // group's own name rather than showing "Set  Reading to ...".
    const shownName = groupLabel(groupName) || groupName;
    if (!confirm(`Set ${shownName} Reading to ${typed}${uom}? This overwrites the accumulated total and cannot be undone.`)) {
      keepDraft();
      return false;
    }
    // From here the field is PENDING: the value is committed as far as
    // this browser is concerned, and no background render may touch it
    // until the device says what became of it.
    if (row) row._readingPending = token;
    setState(READING_PENDING);
    button.disabled = true;
    // ONE request, carrying the exact string that was just confirmed -
    // not a re-read of the input, which is what let a blur handler
    // change the value between the confirmation and the send. It used to
    // be two requests as well (set a number, then press a button that
    // read it back), so a second tab or a retry landing in between made
    // Update apply a value nobody asked for. The device-side entity is a
    // text field precisely so the typed digits arrive as typed: a number
    // entity would be parsed into a float32, which cannot hold
    // "12345.001".
    const outcome = watchUpdateResult(groupName, typed);
    try {
      await postRequest(`${updateEntity.namePath}/set?value=${encodeURIComponent(typed)}`);
    } catch (error) {
      outcome.cancel();
      button.disabled = false;
      showRequestError(error, "Reading update failed");
      revertToLiveReading();
      return false;
    }
    const result = await outcome.promise;
    button.disabled = false;
    if (result && result.status !== "ok") {
      alert(UPDATE_REFUSAL[result.status] || `The device refused this reading (${result.status}).`);
      revertToLiveReading();
      return false;
    }
    if (!result) {
      // Outcome unknown. Hand the field back to live state rather than
      // leaving it pending forever - whatever the device really did, its
      // own updates are now the truth on screen.
      revertToLiveReading();
      return true;
    }
    // Confirmed. Move the local caches to the committed value before
    // releasing the field, so the very next render - from any cause -
    // already has the right number and there is no window where a stale
    // exact value can be rendered back into it. The offset moves by
    // exactly the same amount as the total (that is what an offset is),
    // so both stay exact here rather than waiting for the real numbers.
    const totalMl = parseM3ToMl(typed);
    const totalEntity = groupEntity(groupName, "Total Consumption");
    // The caches move regardless of who owns the field now - the device
    // really did commit this value, and everything else on the page
    // should say so. Only the field itself is off limits if the user has
    // moved on.
    if (totalMl !== null && totalEntity) {
      const previous = exactVolumes.get(groupName);
      const offsetMl = previous ? previous.offsetMl + (totalMl - previous.totalMl) : 0n;
      exactVolumes.set(groupName, { totalMl, offsetMl });
      totalEntity.value = value;
      totalEntity.state = `${value}${uom}`;
      if (stillOurs()) {
        // The canonical rendering of what was committed, so the field
        // ends up showing the same thing the rest of the dashboard does.
        setState(READING_CLEAN);
        input.value = fmtValue(totalEntity);
      }
      render(totalEntity);
    } else if (stillOurs()) {
      setState(READING_CLEAN);
    }
    return true;
  }

  // Whole-string, or nothing. parseFloat() happily stops at the first
  // character it doesn't understand and returns whatever it read so far,
  // which for a field that overwrites a meter's accumulated total is the
  // worst possible failure mode: "12abc" became 12, "1,2,3" became 1.2,
  // "12 345,678" became 12 - each of them a plausible-looking number that
  // the user never typed, applied without a word. Anything that isn't a
  // plain optionally-signed decimal is rejected outright (NaN), and every
  // caller already treats NaN as "refuse and tell them".
  //
  // A single comma is always a decimal separator here, never a thousands
  // separator - these fields are typed free-form, not formatted as you
  // type, so there is no ambiguity to resolve. Both separators are
  // accepted because the field is a plain text input (it had to move off
  // type="number": Safari's own number widget re-renders an assigned
  // .value in the device's locale and its own rounding), so whatever the
  // user's keyboard produces is what arrives here.
  const DECIMAL_INPUT_RE = /^[+-]?\d+(?:[.,]\d+)?$/;

  function parseDecimalInput(str) {
    const text = String(str).trim();
    if (!DECIMAL_INPUT_RE.test(text)) return NaN;
    return parseFloat(text.replace(",", "."));
  }

  // --- Exact volumes -------------------------------------------------------
  // Every meter publishes its total and correction twice: as normal float
  // sensors (what Home Assistant and the ESPHome API consume) and as an
  // "Exact Millilitres" text channel carrying the same two numbers as
  // plain integer millilitres. This dashboard renders the exact channel.
  //
  // Not belt-and-braces: an ESPHome sensor state is a float32, and a
  // float32's spacing passes one millilitre at about 8 m3 and one litre
  // at about 16000 m3. So a flow meter that genuinely reports millilitres
  // would start showing invented digits in its last places well within
  // its normal working range, and a pulse meter's litres would go the
  // same way eventually. This project never truncates or rounds a
  // measurement to paper over that, and there is no rounding that makes
  // a float carry information it doesn't have - so the exact value
  // travels as an integer instead, and is formatted here, in decimal,
  // with no float ever involved.
  const exactVolumes = new Map(); // groupName -> { totalMl: BigInt, offsetMl: BigInt }

  function rememberExactVolumes(entity) {
    const raw = typeof entity.value === "string" ? entity.value : "";
    const parts = raw.split("|");
    if (parts.length !== 2) return;
    try {
      exactVolumes.set(entity.groupName, { totalMl: BigInt(parts[0]), offsetMl: BigInt(parts[1]) });
    } catch (_) {
      // A malformed payload is dropped rather than poisoning the map -
      // fmtValue() then simply falls back to the float sensor's own state
      // string, which is what it did before this channel existed.
    }
  }

  function exactMlFor(entity, label) {
    const record = exactVolumes.get(entity.groupName);
    if (!record) return null;
    if (label === "Total Consumption") return record.totalMl;
    if (label === "Correction Offset") return record.offsetMl;
    return null;
  }

  // Integer millilitres -> a decimal m3 string with exactly `decimals`
  // decimals. All BigInt/string work: 1 m3 is 1e6 ml, so the split is a
  // plain divmod and the fraction is zero-padded to six digits and then
  // trimmed to the precision actually being shown.
  function formatMl(ml, decimals) {
    const negative = ml < 0n;
    const magnitude = negative ? -ml : ml;
    const whole = magnitude / 1000000n;
    const frac = (magnitude % 1000000n).toString().padStart(6, "0");
    const shown = Math.max(0, Math.min(6, decimals));
    const body = shown > 0 ? `${whole}.${frac.slice(0, shown)}` : `${whole}`;
    // A leading minus in front of nothing but zeros carries no magnitude
    // information at the shown precision, same reasoning as
    // stripNegativeZero() below.
    return negative && /[1-9]/.test(body) ? `-${body}` : body;
  }

  // How many decimals this entity's own accuracy_decimals produces, read
  // off the server's own formatted state string ("0.071235 m³" -> 6)
  // rather than hardcoded here - so the firmware's accuracy_decimals
  // stays the single place that decides, exactly as it did before the
  // exact channel existed.
  function decimalsOfState(entity) {
    if (typeof entity.state !== "string") return 0;
    const numeric = entity.state.split(" ")[0];
    const frac = numeric.split(".")[1];
    return frac ? frac.length : 0;
  }

  function fmtValue(entity) {
    const v = entity.value;
    if (v === null || v === undefined || v === "") return "--";
    if (typeof v === "number") {
      if (Number.isNaN(v)) return "--";
      // Exact channel first, where one exists for this entity - see
      // exactVolumes above. Deliberately after the NaN check: a meter
      // whose reading has gone unavailable (a deleted slot, a failed
      // poll) must show "--", not the last exact value it happened to
      // publish before that.
      const exact = exactMlFor(entity, displayName(entity));
      if (exact !== null) return formatMl(exact, decimalsOfState(entity));
      // These are measuring instruments, not estimating ones - rounding
      // the raw value to a fixed 3dp here would silently cut off real,
      // meaningful digits for some readings. Reads the number portion of
      // the server's own pre-formatted `state` string instead (e.g.
      // "0.071234 m³" -> "0.071234") - it already reflects this entity's
      // own configured accuracy_decimals exactly, with no additional
      // client-side rounding layered on top of that. `state` arrives on
      // every full/terse update (see handleFullPayload()/
      // handleStateEvent()), so the raw-value fallback below is only for
      // the rare case it hasn't arrived yet - still no rounding even
      // then, just no accuracy_decimals-aware formatting either.
      if (typeof entity.state === "string" && entity.state) {
        const numeric = entity.state.split(" ")[0];
        if (numeric && !Number.isNaN(parseFloat(numeric))) return stripNegativeZero(numeric);
      }
      return stripNegativeZero(String(v));
    }
    return String(v);
  }

  // "-0.000000" (a real, tiny negative value that rounds to all-zero
  // digits at the configured accuracy_decimals) reads as a rendering
  // glitch. A leading minus in front of nothing but zeros carries no
  // magnitude information at the shown precision, so it's dropped
  // *here, in the display layer only*.
  //
  // Deliberately NOT fixed by snapping the stored value to zero (e.g.
  // < 1e-5 m3 -> 0, in the meter packages' own Update handlers): that
  // would silently destroy a deliberate 1 ml correction, far worse than
  // an ugly zero. The stored value stays exactly as measured; only its
  // rendering changes.
  function stripNegativeZero(str) {
    return /^-0(\.0*)?$/.test(str) ? str.slice(1) : str;
  }

  const SERVICE_DOMAINS = new Set(["number", "button", "switch", "text"]);

  function pageFor(entity) {
    if (entity.category === ENTITY_CATEGORY_DIAGNOSTIC) return "diagnostics";
    if (SERVICE_DOMAINS.has(entity.domain)) return "service";
    return "home";
  }

  // Any entity of `groupName` whose own label (name minus the group
  // prefix) matches - the generic form of pressureSlotEntity()/
  // pulseMeterSlotEntity(), for the places that don't care which kind of
  // device they're looking at.
  function groupEntity(groupName, label) {
    for (const e of entities.values()) {
      if (e.groupName === groupName && displayName(e) === label) return e;
    }
    return null;
  }

  function render(entity) {
    // The exact-millilitre channel is data for OTHER entities' rendering,
    // never a row of its own (see exactVolumes above). It is published
    // right after the float sensors it belongs to, so those have already
    // rendered against a stale (or absent) exact value by the time it
    // lands - re-rendering them here is what makes the displayed reading
    // exact rather than one update behind.
    // Outcome of the last Reading Update - never a row of its own either,
    // it exists so applyTypedReading() can tell whether the device
    // actually took the value (see watchUpdateResult()).
    if (entity.name === "Device Update Result") {
      notifyUpdateResult(entity);
      return;
    }
    if (entity.groupName && displayName(entity) === "Exact Millilitres") {
      rememberExactVolumes(entity);
      for (const label of ["Total Consumption", "Correction Offset"]) {
        const sibling = groupEntity(entity.groupName, label);
        if (sibling) render(sibling);
      }
      return;
    }
    // Header signal-bars widget - see updateSignalBars() above. Matched on
    // the entity's real (compile-time) name, same as everywhere else in
    // this file - independent of pageFor()/Diagnostics placement below,
    // this entity still renders there too, this is purely an additional
    // header shortcut for it.
    if (entity.domain === "sensor" && entity.name === "Wi-Fi Signal") updateSignalBars(entity.value);
    // Modbus device slots (and their "Modbus Devices" umbrella group)
    // bypass the generic Home/Service/Diagnostics dispatch entirely - see
    // the "Modbus device table" section above for why.
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
    if (entity.domain === "button" && (entity.name === "Reboot Device" || entity.name === "Forget Wi-Fi")) {
      upsertDiagButton(entity);
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
    // `name_id` was ESPHome's own transitional field name for this - its web_server.cpp
    // source carried the field's own removal notice verbatim: "Remove in 2026.8.0 when id
    // switches to new format permanently". As of ESPHome 2026.8.1, `name_id` is gone from
    // the SSE payload entirely - `id` now directly holds the same name-based value
    // `name_id` used to. `data.name_id || data.id` covers both
    // eras: prefers `name_id` while a version still sends it (its value never differs from
    // `id` on those versions anyway), falls back to `id` once it's gone. Without this
    // fallback, `pathFromNameId(undefined)` threw mid-handleFullPayload() on 2026.8.1+ -
    // silently, before entity.name/uom/category/groupName/groupWeight/value ever got set or
    // render() got called for that entity - which is why every entity still eventually
    // showed a live value (a later plain "state" event for the same, by-then-registered
    // entity.id updated .value and rendered fine) but always unlabeled, ungrouped, dumped
    // under the "Other" fallback card - exactly the reported symptom, and why reloading the
    // page never helped (deterministic field-name mismatch, not a connect-timing race).
    entity.namePath = pathFromNameId(data.name_id || data.id);
    entity.name = data.name || data.id;
    entity.uom = data.uom;
    entity.category = data.entity_category || 0;
    // Sorting metadata has disappeared from individual entity payloads
    // on some real ESPHome/browser reconnect combinations. These device
    // groups are part of the firmware's stable entity-name contract, so
    // recover them from that name instead of dumping otherwise perfectly
    // identifiable pulse meters into the generic "Other" section.
    const unqualifiedName = /^[a-z_]+\//.test(entity.name)
      ? entity.name.slice(entity.name.indexOf("/") + 1)
      : entity.name;
    const knownDeviceGroup = unqualifiedName.match(/^(Pulse Meter \d+|Modbus Device \d+)(?:\s|$)/)?.[1];
    const knownUmbrellaGroup = unqualifiedName.startsWith("Modbus Devices ") ? PRESSURE_ADD_GROUP : undefined;
    entity.groupName = data.sorting_group || knownDeviceGroup || knownUmbrellaGroup;
    entity.groupWeight = data.sorting_weight;
    if (data.min_value !== undefined) entity.min = data.min_value;
    if (data.max_value !== undefined) entity.max = data.max_value;
    if (data.step !== undefined) entity.step = data.step;
    if (data.mode !== undefined) entity.mode = data.mode;
    if (data.max_length !== undefined) entity.maxLength = data.max_length;
    entity.value = coerceValue(entity.domain, data.value);
    // The server's own pre-formatted display string (e.g. "0.071 m³") -
    // its numeric portion already reflects this entity's own configured
    // accuracy_decimals exactly, see fmtValue()'s own comment for why
    // this is used there instead of re-rounding the raw value client-side.
    if (data.state !== undefined) entity.state = data.state;
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
    if (data.state !== undefined) entity.state = data.state;
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
    const statusEl = document.getElementById("hub-status");
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
  // Deliberately a separate thing from #hub-status/setConnected() above:
  // that tracks whether *this browser's* SSE link to the device is
  // currently open, this tracks the *device's own* upstream Wi-Fi RSSI -
  // two different links, independently healthy or not. Paired with the
  // sensor's 2s update_interval (water-telemetry-hub.yaml - was 60s, far too
  // slow to watch anything happen live), this is what makes something
  // like "does a hand near the board tank the signal" actually visible in
  // real time, instead of only inferable after the fact from a disconnect
  // reason. The exact dBm is still available as a hover/long-press tooltip
  // (title attribute) and on the Diagnostics page's own "Wi-Fi Signal" row.
  //
  // Thresholds are the common phone-style dBm convention (less negative =
  // stronger); tier 0 (unknown/no reading yet) and the gap below -85 both
  // render as all-grey, deliberately not treated as an error state here -
  // #hub-status already owns "something is wrong", this widget only ever
  // says how strong the signal is when there is one.
  const SIGNAL_TIERS = [
    { min: -55, tier: 4 },
    { min: -65, tier: 3 },
    { min: -75, tier: 2 },
    { min: -85, tier: 1 },
  ];
  function updateSignalBars(dbm) {
    const wrap = document.getElementById("hub-wifi-signal");
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
      document.querySelector(`.hub-nav-item[data-page="${p.id}"]`).classList.toggle("active", active);
      document.getElementById(`hub-page-${p.id}`).classList.toggle("active", active);
    }
    document.getElementById("hub-title").textContent = PAGES.find((p) => p.id === id).label;
    // Remembered across reloads (a plain refresh, not just switching
    // tabs within the same load) - a page reload otherwise always
    // dropped back to Home regardless of where you were.
    try {
      localStorage.setItem("hub-page", id);
    } catch (e) {
      // Private browsing / storage disabled - losing the remembered page
      // isn't worth failing anything else over.
    }
  }

  // Reads back the remembered page for the very first render - falls
  // back to Home for a first-ever visit or an unrecognized/corrupt value.
  function loadRememberedPage() {
    let saved = null;
    try {
      saved = localStorage.getItem("hub-page");
    } catch (e) {
      // ignore, see selectPage()
    }
    return PAGES.some((p) => p.id === saved) ? saved : "home";
  }

  function buildShell() {
    const root = el("div", null);
    root.id = "hub-root";
    root.innerHTML = `
      <nav id="hub-nav">${PAGES.map(
        (p) => `<button class="hub-nav-item" data-page="${p.id}">${svgIcon(p.icon)}<span>${p.label}</span></button>`
      ).join("")}</nav>
      <main id="hub-main">
        <div id="hub-header">
          <h1 id="hub-title">Home</h1>
          <div id="hub-header-right">
            <div id="hub-wifi-signal" data-tier="0">
              <svg viewBox="0 0 24 22" aria-hidden="true">
                <path class="arc arc-3" d="M3 8.5a15 15 0 0 1 18 0"/>
                <path class="arc arc-2" d="M6.3 12a10.5 10.5 0 0 1 11.4 0"/>
                <path class="arc arc-1" d="M9.5 15.5a6 6 0 0 1 5 0"/>
                <circle class="dot" cx="12" cy="18.5" r="1.4"/>
              </svg>
            </div>
            <div id="hub-status"><span class="dot"></span><span class="label">Connecting…</span></div>
          </div>
        </div>
        <section id="hub-page-home" class="hub-page"></section>
        <section id="hub-page-service" class="hub-page"></section>
        <section id="hub-page-diagnostics" class="hub-page"></section>
        <section id="hub-page-log" class="hub-page">
          <div id="hub-log-toolbar">
            <button id="hub-log-clear" class="hub-btn">Clear</button>
            <!-- Plain link, no JS needed - components/log_ring_buffer/ (a
                 local ESPHome component, same pattern as this project's
                 own web_server_idf fork) serves a RAM-only ring buffer of
                 recent log lines at this URL with a Content-Disposition:
                 attachment header, so the browser just downloads it like
                 any other file link. Independent of "Clear" above (which
                 only clears what THIS tab has rendered from SSE) and of
                 whatever's currently on screen - always the device's own,
                 separately-kept copy since last boot. #hub-log-toolbar
                 .hub-btn (dashboard.css) already sizes this to content,
                 same as the Clear button, no hub-btn-compact needed. -->
            <a id="hub-log-download" class="hub-btn" href="/log.txt">Download Log</a>
          </div>
          <pre id="hub-log"></pre>
        </section>
      </main>`;
    document.body.appendChild(root);
    root.querySelectorAll(".hub-nav-item").forEach((btn) => btn.addEventListener("click", () => selectPage(btn.dataset.page)));
    document.getElementById("hub-log-clear").addEventListener("click", () => {
      document.getElementById("hub-log").innerHTML = "";
    });
    selectPage(currentPage);
  }

  // The dynamically-generated web_server v3 index.html (build_index_html()
  // in ESPHome's own source) doesn't set a <meta name="viewport"> at all -
  // only the older v1 HTML generator does. Without it, iOS Safari renders
  // the page at desktop width and our @media breakpoint in dashboard.css
  // never triggers. Since this script owns the whole page anyway,
  // patch it in here instead of depending on ESPHome's generated <head>.
  // The apple-mobile-web-app-* tags additionally make "Add to Home
  // Screen" launch this as a standalone, browser-chrome-free app.
  function fixMobileMeta() {
    const metas = [
      ["name", "viewport", "width=device-width, initial-scale=1, viewport-fit=cover"],
      ["name", "apple-mobile-web-app-capable", "yes"],
      ["name", "apple-mobile-web-app-status-bar-style", "black-translucent"],
      ["name", "apple-mobile-web-app-title", "Telemetry Hub"],
    ];
    for (const [attr, name, content] of metas) {
      if (document.head.querySelector(`meta[${attr}="${name}"]`)) continue;
      const m = document.createElement("meta");
      m.setAttribute(attr, name);
      m.setAttribute("content", content);
      document.head.appendChild(m);
    }
    document.title = "Water Telemetry Hub";
    // The icons themselves are served by the firmware (components/
    // web_icons) - the tab icon from /favicon.svg, the home-screen icon
    // from /apple-touch-icon.png. ESPHome's generated <head> already has
    // an EMPTY <link rel=icon href=data:> (its way of stopping the
    // browser's automatic /favicon.ico request), so that one is
    // repointed rather than duplicated. The apple-touch-icon link is
    // belt and braces: iOS fetches /apple-touch-icon.png from the site
    // root on its own, but only after trying the link first.
    let icon = document.head.querySelector('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      document.head.appendChild(icon);
    }
    icon.type = "image/svg+xml";
    icon.href = "/favicon.svg";
    if (!document.head.querySelector('link[rel="apple-touch-icon"]')) {
      const touch = document.createElement("link");
      touch.rel = "apple-touch-icon";
      touch.href = "/apple-touch-icon.png";
      document.head.appendChild(touch);
    }
  }

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

  // Standalone-mode #hub-nav gap - still unsolved, see REQUIREMENTS.md/
  // commit history for the failed attempts and why. Real-device confirmed
  // WRONG (made it worse - clipped the nav under an opaque bar instead of
  // just leaving a gap above it): pushing #hub-nav down via a negative
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
