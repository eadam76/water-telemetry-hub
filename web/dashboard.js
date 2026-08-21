
(function () {
  "use strict";

  const ENTITY_CATEGORY_DIAGNOSTIC = 2;
  const NUMBER_MODE_SLIDER = 2;
  const FALLBACK_GROUP = "Other";

  const HELP_TEXT = {
    "Total Consumption": "Cumulative water use - read directly from the meter's own accumulated total (Modbus flow meters), or calculated from the pulse count and the last calibration (pulse meters). Either way, not a live meter photograph.",
    "Calculated Flow Rate": "Instantaneous flow, based on the time between the last two pulses. Drops to 0 automatically after Zero-Flow Timeout with no new pulses.",
    "Reading": "Enter the physical meter's current reading here, then press Update to apply it. Typing here alone changes nothing.",
    "Zero-Flow Timeout": "How long with no pulses before Calculated Flow Rate is shown as 0. Lower reacts faster; higher tolerates slow trickles without a false zero.",
    "Display Name": "Shown instead of the fixed name above, on the Dashboard page and here.",
    "Flow Rate": "Live instantaneous flow rate, read directly from the Modbus flow meter - not derived from pulse timing the way the pulse meters' own Calculated Flow Rate is.",
  };

  // Buttons/fields whose action isn't easily undone get an explicit
  // confirmation before firing (CR #4, #6) - matched by displayName(),
  // so it applies uniformly across meters without hardcoding names.
  const CONFIRM_ON_PRESS = new Set(["Update", "Reboot Device", "Forget Wi-Fi", "Delete"]);
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
    if (home) home.card.querySelector(".dc-meter-card-header-label").textContent = label;
    const svc = serviceGroups.get(name);
    if (svc) svc.section.querySelector(".dc-section-label").textContent = label;
    const diag = diagGroups.get(name);
    if (diag) diag.section.querySelector(".dc-section-label").textContent = label;
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
    if (home) home.card.classList.toggle("dc-hidden", !enabled);
  }

  // --- Home page: one card per meter's sorting_group ------------------

  const homeGroups = new Map(); // groupName -> { weight, card, body }

  function ensureHomeGroup(name) {
    let g = homeGroups.get(name);
    if (g) return g;
    const card = el("div", "dc-meter-card");
    const header = el("div", "dc-meter-card-header");
    // Icon lives in its own element (not just a raw svgIcon() string
    // baked into the header's innerHTML at creation time) so it can be
    // refreshed later - see refreshGroupIcon() below. Only matters for
    // pressure slots today (groupIcon() depends on that slot's own,
    // async-arriving Device Type entity - every other group's icon is a
    // static lookup that never changes after creation), but keeping this
    // generic costs nothing.
    const iconEl = el("span", "dc-meter-card-header-icon", svgIcon(groupIcon(name)));
    const labelEl = el("span", "dc-meter-card-header-label", groupLabel(name));
    const statusEl = el("span", "dc-pressure-badge dc-meter-card-status", "");
    header.append(iconEl, labelEl, statusEl);
    const body = el("div", "dc-meter-card-body");
    card.append(header, body);
    g = { weight: groupWeights.get(name) ?? 500, card, body, iconEl, statusEl };
    homeGroups.set(name, g);
    document.getElementById("dc-page-home").appendChild(card);
    reorderHomeGroups();
    applyGroupVisibility(name); // no-op until the initial SSE burst settles - see settleInitialBurst()
    return g;
  }

  function refreshGroupIcon(name) {
    const home = homeGroups.get(name);
    if (home) home.iconEl.innerHTML = svgIcon(groupIcon(name));
  }

  const PRESSURE_BADGE_CLASSES = [
    "dc-pressure-badge-ok",
    "dc-pressure-badge-lost",
    "dc-pressure-badge-collision",
    "dc-pressure-badge-mismatch",
    "dc-pressure-badge-pending",
  ];
  function pressureStatusState(online, hasCollision, hasMismatch) {
    if (hasCollision) return { text: "Collision", cssClass: "dc-pressure-badge-collision" };
    if (hasMismatch) return { text: "Mismatch", cssClass: "dc-pressure-badge-mismatch" };
    if (online === undefined) return { text: "Checking…", cssClass: "dc-pressure-badge-pending" };
    return online ? { text: "OK", cssClass: "dc-pressure-badge-ok" } : { text: "Lost", cssClass: "dc-pressure-badge-lost" };
  }

  function updateHomeCardStatus(groupName, text, cssClass) {
    const home = homeGroups.get(groupName);
    if (!home || !home.statusEl) return;
    home.statusEl.textContent = text;
    for (const c of PRESSURE_BADGE_CLASSES) home.statusEl.classList.toggle(c, c === cssClass);
  }

  function reorderHomeGroups() {
    const container = document.getElementById("dc-page-home");
    for (const g of [...homeGroups.values()].sort((a, b) => a.weight - b.weight)) {
      container.appendChild(g.card);
    }
  }

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

  // --- Diagnostics ("System") page: grouped label/value rows, plus a
  // `fields` area for the handful of device-level action buttons that
  // moved here from the Devices page (Reboot Device, Forget Wi-Fi - see
  // the special-case in render() and upsertDiagButton() below). Mirrors
  // ensureServiceGroup()'s own `fields` container/styling (.dc-fields/
  // .dc-field are generic, not scoped to .dc-service-group) rather than
  // inventing a second, near-identical button layout.

  // Two sub-areas per group, both optional-in-practice (only actually
  // populated once something upserts into them): `list` (plain read-only
  // label/value rows, the page's original purpose) and `actions`
  // (compact, intrinsically-sized buttons in a flex row - Reboot Device/
  // Forget Wi-Fi).
  const diagGroups = new Map(); // groupName -> { weight, section, list, actions }

  function ensureDiagGroup(name) {
    let g = diagGroups.get(name);
    if (g) return g;
    const section = el("div", "dc-diag-group");
    const label = el("div", "dc-section-label", groupLabel(name));
    const list = el("div", "dc-list");
    const actions = el("div", "dc-diag-actions");
    section.append(label, list, actions);
    g = { weight: groupWeights.get(name) ?? 500, section, list, actions };
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

  function reorderDiagActions(group) {
    for (const r of [...group.actions.children].sort((a, b) => (+a.dataset.weight) - (+b.dataset.weight))) {
      group.actions.appendChild(r);
    }
  }

  // reorderServiceFields() (defined further down, in the Devices-page
  // section) is already fully generic - it only ever touches
  // `group.fields`, never anything Devices-page-specific - so this reuses
  // it verbatim rather than maintaining a duplicate copy for the System
  // page's own `fields` (the proper .dc-field-card area, not the
  // compact-button .dc-diag-actions row above).
  const reorderDiagFields = (group) => reorderServiceFields(group);

  function upsertDiagButton(entity) {
    const group = ensureDiagGroup(entity.groupName ?? FALLBACK_GROUP);
    if (!entity.btnEl) {
      entity.btnEl = el("button", "dc-btn dc-btn-compact", entity.name);
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


  const PRESSURE_SLOT_RE = /^Pressure Sensor \d+$/;
  const PRESSURE_ADD_GROUP = "Pressure Sensors";
  const PRESSURE_MAX_SLOTS = 8;
  const TYPE_READING_HINT = {
    "": "Choose a device type to see what it'll add",
    Pressure: "→ Pressure, bar",
    Flow: "→ Total Consumption, m³ + Flow Rate, m³/h",
  };
  // Real firmware sorting_group name (water-collector.yaml's
  // sorting_group_pulse_meters) - kept purely for its own sorting_weight
  // (used below to position the unified "Devices" table), same as
  // PRESSURE_ADD_GROUP's weight is used for the same purpose. No entity
  // is tagged directly to it (see that group's own comment in
  // water-collector.yaml).
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

  function latestMismatchAddresses() {
    const e = pressureSlotEntity(PRESSURE_ADD_GROUP, "Scan Mismatches");
    if (!e || typeof e.value !== "string" || !e.value.trim()) return [];
    return e.value
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 247);
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
    const section = el("div", "dc-service-group dc-pressure-group");
    const toolbar = el("div", "dc-pressure-toolbar");
    const table = el(
      "table",
      "dc-pressure-table",
      `<thead><tr><th>Name</th><th>Status</th><th></th><th></th></tr></thead><tbody></tbody>`
    );
    // A future extra column has to go somewhere; scrolling the table
    // itself horizontally, on whichever screen is too narrow for it,
    // beats squeezing every column down or clipping content outright
    // (#dc-main forces overflow-x: hidden page-wide - see its own
    // comment).
    const tableScroll = el("div", "dc-pressure-table-scroll");
    tableScroll.appendChild(table);
    const card = el("div", "dc-devices-card");
    card.append(tableScroll, toolbar);
    section.append(card);
    g = { weight: groupWeights.get(PULSE_METER_ANCHOR_GROUP) ?? groupWeights.get(PRESSURE_ADD_GROUP) ?? 500, section };
    serviceGroups.set(DEVICE_TABLE_GROUP, g);
    document.getElementById("dc-page-service").appendChild(section);
    reorderServiceGroups();
    deviceTableBody = table.querySelector("tbody");
    deviceToolbarEl = toolbar;
    mountDeviceAddButtons();
    return deviceTableBody;
  }

  let addPulseBtn = null;
  function mountDeviceAddButtons() {
    if (addPulseBtn) return;
    addPulseBtn = el("button", "dc-btn dc-btn-compact", "Add Pulse Meter");
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
      entity.btnEl = el("button", "dc-btn dc-btn-compact", entity.idleLabel);
      entity.btnEl.addEventListener("click", () => {
        if (entity.btnEl.disabled) return;
        // A fresh, deliberate scan supersedes any earlier session-local
        // dismissal (dismissDeviceAddRow.../dismissedScanAddresses below)
        // - the user explicitly asked to see the bus's current state
        // again, not whatever was previously waved away.
        dismissedScanAddresses.clear();
        postRequest(`${entity.namePath}/press`).catch((error) => showRequestError(error, "Device scan failed"));
      });
      entity.statusEl = el("span", "dc-pressure-scan-status", `<span class="dc-spinner"></span><span>Scanning…</span>`);
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
        "dc-pressure-row-registered",
        `<td class="dc-pressure-name"></td><td class="dc-pressure-status"></td><td class="dc-pressure-action"></td><td class="dc-pressure-order"></td>`
      );
      deviceTableRows.set(key, row);
      tbody.appendChild(row);

      const nameCell = row.querySelector(".dc-pressure-name");
      const nameRow = el("div", "dc-pressure-name-row");
      nameCell.appendChild(nameRow);
      const typeIcon = el("span", "dc-device-type-icon", svgIcon("gauge"));
      nameRow.appendChild(typeIcon);
      row._typeIconEl = typeIcon;
      const nameContent = el("div", "dc-pressure-name-content");
      nameRow.appendChild(nameContent);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 32;
      nameInput.disabled = true;
      nameContent.appendChild(nameInput);
      row._nameInput = nameInput;

      const status = el("span", "dc-pressure-badge");
      row.querySelector(".dc-pressure-status").appendChild(status);
      row._statusEl = status;

      const actionCell = row.querySelector(".dc-pressure-action");

      const editBtn = el("button", "dc-pressure-icon-btn dc-pressure-edit-btn", svgIcon("pencil"));
      editBtn.type = "button";
      editBtn.title = "Edit name/address";
      actionCell.appendChild(editBtn);
      row._editBtn = editBtn;

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

      // Up/Down - reorders this row relative to every OTHER registered
      // device, of either type (moveDeviceRow() above), independent of
      // the edit lock above (no need to press the pencil first).
      // Physically the slot doesn't move at all, only the Sort Order
      // metadata each device carries - see that number entity's own
      // comment in pressure_sensor.yaml. Disabled at whichever end of the
      // list a row already sits at (isFirst/isLast below), rather than
      // just being a no-op click - visibly not just cosmetically
      // first/last.
      const orderGroup = el("div", "dc-pressure-order-group");
      row.querySelector(".dc-pressure-order").appendChild(orderGroup);
      const upBtn = el("button", "dc-pressure-icon-btn dc-pressure-order-btn", svgIcon("chevronUp"));
      upBtn.type = "button";
      upBtn.title = "Move up";
      upBtn.addEventListener("click", () => moveDeviceRow(groupName, -1));
      const downBtn = el("button", "dc-pressure-icon-btn dc-pressure-order-btn", svgIcon("chevronDown"));
      downBtn.type = "button";
      downBtn.title = "Move down";
      downBtn.addEventListener("click", () => moveDeviceRow(groupName, 1));
      orderGroup.append(upBtn, downBtn);
      row._upBtn = upBtn;
      row._downBtn = downBtn;

      // Expand row - Modbus Address only, editable, same "only exists
      // while editing" pattern as the pulse meters' own expand row below.
      const expandedRow = el("tr", "dc-pulsemeter-expanded");
      const expandedCell = document.createElement("td");
      expandedCell.colSpan = 4;
      expandedRow.appendChild(expandedCell);
      const addrLine = el("div", "dc-pulsemeter-expanded-field");
      const addrLabel = el("span", "dc-pulsemeter-expanded-label", "Modbus Address");
      const addrInput = document.createElement("input");
      addrInput.type = "number";
      addrInput.min = 1;
      addrInput.max = 247;
      addrInput.step = 1;
      addrLine.append(addrLabel, addrInput);
      expandedCell.appendChild(addrLine);
      row._expandedRow = expandedRow;
      row._addrInput = addrInput;

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
        nameInput.disabled = false;
        addrInput.disabled = false;
        row.classList.add("dc-pressure-row-editing");
        row._editing = true;
        tbody.insertBefore(expandedRow, row.nextSibling);
        nameInput.focus();
        nameInput.select();
      };
      const exitEdit = () => {
        nameInput.disabled = true;
        addrInput.disabled = true;
        row.classList.remove("dc-pressure-row-editing");
        row._editing = false;
        if (expandedRow.isConnected) expandedRow.remove();
        if (deviceEditingRow === row) deviceEditingRow = null;
      };
      const cancelEdit = () => {
        nameInput.value = row._editOrigName;
        addrInput.value = row._editOrigAddr;
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
        const ne = pressureSlotEntity(groupName, "Display Name");
        const ae = pressureSlotEntity(groupName, "Modbus Address");
        saveBtn.disabled = true;
        cancelBtn.disabled = true;
        const requests = [];
        if (ne) requests.push(postRequest(`${ne.namePath}/set?value=${encodeURIComponent(nameInput.value)}`));
        if (ae) requests.push(postRequest(`${ae.namePath}/set?value=${encodeURIComponent(parsed)}`));
        try {
          await Promise.all(requests);
          exitEdit();
        } catch (error) {
          showRequestError(error, "Device update failed");
        } finally {
          saveBtn.disabled = false;
          cancelBtn.disabled = false;
        }
      });
    }
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

  function upsertNewPressureRow(tbody, address, atCeiling) {
    const key = "new:" + address;
    let row = deviceTableRows.get(key);
    if (!row) {
      row = el(
        "tr",
        "dc-pressure-row-new",
        `<td class="dc-pressure-name"></td><td class="dc-pressure-status"><span class="dc-pressure-badge dc-pressure-badge-new">New</span></td><td class="dc-pressure-action"></td><td class="dc-pressure-order"></td>`
      );
      deviceTableRows.set(key, row);
      tbody.appendChild(row);

      const nameCell = row.querySelector(".dc-pressure-name");
      const nameRow = el("div", "dc-pressure-name-row");
      nameCell.appendChild(nameRow);
      const typeIcon = el("span", "dc-device-type-icon", svgIcon("dot"));
      nameRow.appendChild(typeIcon);
      row._typeIconEl = typeIcon;
      const nameContent = el("div", "dc-pressure-name-content");
      nameRow.appendChild(nameContent);
      nameContent.appendChild(el("span", "dc-pressure-addr-hint", `Modbus address: ${address}`));

      const editRow = el("div", "dc-pressure-name-edit-row");
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
      typeSelect.className = "dc-pressure-type-select";
      typeSelect.innerHTML = `<option value="" selected disabled>Type…</option><option value="Pressure">Pressure</option><option value="Flow">Flow</option>`;
      editRow.appendChild(typeSelect);
      row._typeSelect = typeSelect;

      const typeHint = el("span", "dc-pressure-type-hint", TYPE_READING_HINT[""]);
      nameContent.appendChild(typeHint);
      const updateTypePreview = () => {
        const flow = typeSelect.value === "Flow";
        typeIcon.innerHTML = svgIcon(typeSelect.value ? (flow ? "flow" : "gauge") : "dot");
        typeHint.textContent = TYPE_READING_HINT[typeSelect.value];
        if (!row._confirmBtn._busy) row._confirmBtn.disabled = atCeiling || !nameInput.value.trim() || !typeSelect.value;
      };
      typeSelect.addEventListener("change", updateTypePreview);

      const actionCell = row.querySelector(".dc-pressure-action");

      const confirmBtn = el("button", "dc-pressure-icon-btn dc-pressure-save-btn", svgIcon("check"));
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
        try {
          await postRequest(`${nameEntity.namePath}/set?value=${encodeURIComponent(name)}`);
          // ESPHome select endpoints use `option`; number/text endpoints
          // use `value`.
          await postRequest(`${typeEntity.namePath}/set?option=${encodeURIComponent(deviceType)}`);
          await postRequest(`${addrEntity.namePath}/set?value=${encodeURIComponent(address)}`);
          await postRequest(`${addEntity.namePath}/press`);
          pressureNewRowDrafts.delete(address);
        } catch (error) {
          showRequestError(error, "Device add failed");
        } finally {
          confirmBtn._busy = false;
          confirmBtn.disabled = atCeiling;
        }
      });
      row._confirmBtn = confirmBtn;

      const dismissBtn = el("button", "dc-pressure-icon-btn dc-pressure-cancel-btn", svgIcon("close"));
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
    if (!row._confirmBtn._busy) {
      const nameEmpty = !row._nameInput.value.trim();
      const typeUnset = !row._typeSelect.value;
      row._confirmBtn.disabled = atCeiling || nameEmpty || typeUnset;
      row._confirmBtn.title = atCeiling
        ? "All 8 sensor slots are already registered - delete one first to add another."
        : nameEmpty
          ? "Enter a name first."
          : typeUnset
            ? "Choose a device type first."
            : "Add";
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
    let row = deviceTableRows.get(key);
    if (!row) {
      row = el(
        "tr",
        "dc-pressure-row-collision",
        `<td class="dc-pressure-name"></td>` +
          `<td class="dc-pressure-status"><span class="dc-pressure-badge dc-pressure-badge-collision">Collision</span></td>` +
          `<td class="dc-pressure-action"></td>` +
          `<td class="dc-pressure-order"></td>`
      );
      deviceTableRows.set(key, row);
      tbody.appendChild(row);
      const nameCell = row.querySelector(".dc-pressure-name");
      const nameRow = el("div", "dc-pressure-name-row");
      nameCell.appendChild(nameRow);
      nameRow.appendChild(el("span", "dc-device-type-icon", svgIcon("gauge")));
      const nameContent = el("div", "dc-pressure-name-content");
      nameRow.appendChild(nameContent);
      nameContent.appendChild(el("span", "dc-pressure-addr-hint", `Modbus address: ${address}`));
      nameContent.appendChild(el("span", "dc-pressure-collision-note", "Multiple devices may share this address"));
    }
  }

  function updateDeviceEmptyState(tbody, isEmpty) {
    let placeholder = tbody.querySelector(".dc-pressure-empty");
    if (isEmpty && !placeholder) {
      placeholder = el(
        "tr",
        "dc-pressure-empty",
        `<td colspan="4">No devices yet - press "Find Modbus Devices" to scan for a Modbus sensor, or use the "Add Pulse Meter" button below.</td>`
      );
      tbody.appendChild(placeholder);
    } else if (!isEmpty && placeholder) {
      placeholder.remove();
    }
  }

  const dismissedScanAddresses = new Set();

  function suppressStaleHover(tbody) {
    tbody.classList.add("dc-pressure-table-settling");
    document.addEventListener("mousemove", () => tbody.classList.remove("dc-pressure-table-settling"), { once: true });
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
    const row = el("tr", "dc-device-add-row");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    row.appendChild(cell);

    const form = el("div", "dc-device-add-form");
    cell.appendChild(form);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 32;
    nameInput.placeholder = "Device name";
    nameInput.autocomplete = "off";
    const slotSelect = document.createElement("select");

    const errorEl = el("span", "dc-device-add-error", "");

    const confirmBtn = el("button", "dc-pressure-icon-btn dc-pressure-save-btn", svgIcon("check"));
    confirmBtn.type = "button";
    confirmBtn.title = "Add";
    const cancelBtn = el("button", "dc-pressure-icon-btn dc-pressure-cancel-btn", svgIcon("close"));
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
  // next to the SH1.0 pulse connector (docs/hardver/esp32-s3-rs485-can-
  // board.md), not the internal group name.
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
  const PRESSURE_METRIC_LABELS = ["Pressure", "Total Consumption", "Flow Rate"];

  function pressureSlotValueLabels(groupName) {
    const typeEntity = pressureSlotEntity(groupName, "Device Type");
    if (!typeEntity || typeEntity.value === undefined) return [];
    return typeEntity.value === "Flow" ? ["Total Consumption", "Flow Rate"] : ["Pressure"];
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
      else if (label === "Scan Results" || label === "Scan Collisions") {
        // See scanResultsFresh's own comment further up - only an update
        // arriving after the initial dump has already settled counts as
        // an actual new scan; one that arrives as part of the dump
        // itself (initialSettled still false here) is old, persisted
        // state, not a fresh result.
        if (initialSettled) scanResultsFresh = true;
        renderDeviceTableBody();
      } else if (label === "Scan In Progress") syncScanButtonBusyState(entity.value === true);
      // Add Name / Add Target Address / Add itself have no visible UI of
      // their own - they're write-only targets set by each scan-
      // discovered new-device row's own Confirm icon above, never
      // rendered directly.
      return;
    }
    renderDeviceTableBody();
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
        `<td class="dc-pressure-name"></td><td class="dc-pressure-status"></td><td class="dc-pressure-action"></td><td class="dc-pressure-order"></td>`
      );
      deviceTableRows.set(key, row);
      tbody.appendChild(row);

      const nameCell = row.querySelector(".dc-pressure-name");
      const nameRow = el("div", "dc-pressure-name-row");
      nameCell.appendChild(nameRow);
      nameRow.appendChild(el("span", "dc-device-type-icon", svgIcon("water")));
      const nameContent = el("div", "dc-pressure-name-content");
      nameRow.appendChild(nameContent);

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 32;
      nameInput.disabled = true;
      nameContent.appendChild(nameInput);
      row._nameInput = nameInput;

      const status = el("span", "dc-pressure-badge dc-pressure-badge-pending", "Idle");
      row.querySelector(".dc-pressure-status").appendChild(status);
      row._statusEl = status;

      const actionCell = row.querySelector(".dc-pressure-action");
      const editBtn = el("button", "dc-pressure-icon-btn dc-pressure-edit-btn", svgIcon("pencil"));
      editBtn.type = "button";
      editBtn.title = "Edit";
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

      // Up/Down - same shared cross-type ordering as the pressure rows
      // (moveDeviceRow() above), independent of the edit lock (no need to
      // press the pencil first).
      const orderGroup = el("div", "dc-pressure-order-group");
      row.querySelector(".dc-pressure-order").appendChild(orderGroup);
      const upBtn = el("button", "dc-pressure-icon-btn dc-pressure-order-btn", svgIcon("chevronUp"));
      upBtn.type = "button";
      upBtn.title = "Move up";
      upBtn.addEventListener("click", () => moveDeviceRow(groupName, -1));
      const downBtn = el("button", "dc-pressure-icon-btn dc-pressure-order-btn", svgIcon("chevronDown"));
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
      const expandedRow = el("tr", "dc-pulsemeter-expanded");
      const expandedCell = document.createElement("td");
      expandedCell.colSpan = 4;
      expandedRow.appendChild(expandedCell);

      const readingLine = el("div", "dc-pulsemeter-expanded-field");
      const readingLabel = el("span", "dc-pulsemeter-expanded-label", "Reading");
      const readingInput = document.createElement("input");
      readingInput.type = "number";
      const updateBtn = el("button", "dc-btn dc-btn-compact", "Update");
      updateBtn.type = "button";
      readingLine.append(readingLabel, readingInput, updateBtn);

      const zftLine = el("div", "dc-pulsemeter-expanded-field");
      const zftLabel = el("span", "dc-pulsemeter-expanded-label", "Zero-Flow Timeout");
      const zftInput = document.createElement("input");
      zftInput.type = "number";
      const zftUnit = el("span", "dc-pulsemeter-expanded-unit", "s");
      zftLine.append(zftLabel, zftInput, zftUnit);

      expandedCell.append(readingLine, zftLine);
      row._expandedRow = expandedRow;
      row._readingInput = readingInput;
      row._updateBtn = updateBtn;
      row._zftInput = zftInput;

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
        nameInput.disabled = false;
        row.classList.add("dc-pressure-row-editing");
        row._editing = true;
        tbody.insertBefore(expandedRow, row.nextSibling);
        nameInput.focus();
        nameInput.select();
      };
      const exitEdit = () => {
        nameInput.disabled = true;
        row.classList.remove("dc-pressure-row-editing");
        row._editing = false;
        if (expandedRow.isConnected) expandedRow.remove();
        if (deviceEditingRow === row) deviceEditingRow = null;
        const totalConsumptionEntity = pulseMeterSlotEntity(groupName, "Total Consumption");
        row._readingInput.value = totalConsumptionEntity ? totalConsumptionEntity.value ?? "" : "";
        const zftEntity = pulseMeterSlotEntity(groupName, "Zero-Flow Timeout");
        if (zftEntity) row._zftInput.value = zftEntity.value ?? "";
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
        saveBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
          await postRequest(`${ne.namePath}/set?value=${encodeURIComponent(nameInput.value)}`);
          exitEdit();
        } catch (error) {
          showRequestError(error, "Pulse meter update failed");
        } finally {
          saveBtn.disabled = false;
          cancelBtn.disabled = false;
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
        input.addEventListener("change", () => {
          const parsed = parseFloat(input.value);
          const outOfRange =
            Number.isNaN(parsed) || (entity.min !== undefined && parsed < entity.min) || (entity.max !== undefined && parsed > entity.max);
          const live = liveEntity();
          if (outOfRange) {
            input.value = live ? live.value ?? "" : "";
            return;
          }
        });
        // Enter = Update (with its own confirm dialog, same as a mouse
        // click there - see that button's own handler just below), NOT
        // "Save the whole row" the way Name's Enter works - Reading
        // commits only through the explicit Update action, direct
        // feedback: "azt valahogy külön kéne kezelni, csak update-re
        // engednék fogyasztást felülírni" (it needs handling separately
        // somehow, I'd only allow overwriting consumption via Update).
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
      if (document.activeElement !== input) {
        const live = liveEntity();
        input.value = live ? live.value ?? "" : "";
      }
    } else if (label === "Update") {
      if (!row._updateWired) {
        row._updateBtn.addEventListener("click", async () => {
          const readingEntity = pulseMeterSlotEntity(entity.groupName, "Reading");
          if (!readingEntity) return;
          const value = parseFloat(row._readingInput.value);
          const invalid =
            Number.isNaN(value) ||
            (readingEntity.min !== undefined && value < readingEntity.min) ||
            (readingEntity.max !== undefined && value > readingEntity.max);
          if (invalid) {
            alert("Reading must be a valid value within the allowed range.");
            return;
          }
          const uom = readingEntity.uom ? ` ${readingEntity.uom}` : "";
          if (!confirm(`Set ${entity.groupName} Reading to ${value}${uom}? This overwrites the accumulated total and cannot be undone.`)) return;
          row._updateBtn.disabled = true;
          try {
            // The button reads the device-side Reading entity. Await the
            // value write so it can never apply an older staged value.
            await postRequest(`${readingEntity.namePath}/set?value=${encodeURIComponent(value)}`);
            await postRequest(`${entity.namePath}/press`);
          } catch (error) {
            showRequestError(error, "Reading update failed");
          } finally {
            row._updateBtn.disabled = false;
          }
        });
        row._updateWired = true;
      }
    } else if (label === "Zero-Flow Timeout") {
      const input = row._zftInput;
      if (entity.min !== undefined) input.min = entity.min;
      if (entity.max !== undefined) input.max = entity.max;
      if (entity.step !== undefined) input.step = entity.step;
      if (!row._zftWired) {
        input.addEventListener("change", () => {
          const parsed = parseFloat(input.value);
          const outOfRange =
            Number.isNaN(parsed) || (entity.min !== undefined && parsed < entity.min) || (entity.max !== undefined && parsed > entity.max);
          if (outOfRange) {
            input.value = entity.value ?? "";
            return;
          }
          postRequest(`${entity.namePath}/set?value=${encodeURIComponent(input.value)}`).catch((error) =>
            showRequestError(error, "Zero-flow timeout update failed")
          );
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            input.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            row._cancelEdit();
          }
        });
        row._zftWired = true;
      }
      if (document.activeElement !== input) input.value = entity.value ?? "";
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
    for (const badge of badges) badge.classList.remove("dc-pulse-flash");
    void badges[0].offsetWidth;
    for (const badge of badges) badge.classList.add("dc-pulse-flash");
    clearTimeout(pulseFlashTimers.get(groupName));
    pulseFlashTimers.set(
      groupName,
      setTimeout(() => {
        for (const badge of badges) badge.classList.remove("dc-pulse-flash");
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
    row._statusEl.classList.toggle("dc-pressure-badge-ok", flowing);
    row._statusEl.classList.toggle("dc-pressure-badge-pending", !flowing);
    updateHomeCardStatus(groupName, text, flowing ? "dc-pressure-badge-ok" : "dc-pressure-badge-pending");
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
  function upsertServiceText(entity, ensureGroupFn = ensureServiceGroup) {
    const group = ensureGroupFn(entity.groupName ?? FALLBACK_GROUP);
    const label = displayName(entity);
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
        "dc-field",
        `<div class="label"><span class="label-text"></span></div><div class="dc-field-row"></div>`
      );
      const toggle = el("button", "dc-toggle", "");
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.addEventListener("click", () => {
        postRequest(`${entity.namePath}/toggle`).catch((error) => showRequestError(error, `${displayName(entity)} update failed`));
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

  async function pressButton(entity) {
    const label = displayName(entity);
    if (CONFIRM_ON_PRESS.has(label) && !confirm(confirmMessageForPress(entity, label))) return;
    const btn = entity.btnEl;
    btn.classList.add("dc-pressed");
    try {
      await postRequest(`${entity.namePath}/press`);
    } catch (error) {
      showRequestError(error, `${label} failed`);
    } finally {
      setTimeout(() => btn.classList.remove("dc-pressed"), 400);
    }
  }

  // Update's confirmation names the actual value about to be applied
  // (read straight off the paired Reading field's input) rather than a
  // generic "are you sure?" - Reboot Device just needs a plain yes/no.
  function confirmMessageForPress(entity, label) {
    if (label === "Reboot Device") return "Reboot the device now?";
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
        postRequest(`${entity.namePath}/toggle`).catch((error) => showRequestError(error, "Modbus debug toggle failed"));
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
      postRequest(`${entity.namePath}/set?value=${encodeURIComponent(value)}`).catch((error) =>
        console.error("Reading prefill failed", error)
      );
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
              <svg viewBox="0 0 24 22" aria-hidden="true">
                <path class="arc arc-3" d="M3 8.5a15 15 0 0 1 18 0"/>
                <path class="arc arc-2" d="M6.3 12a10.5 10.5 0 0 1 11.4 0"/>
                <path class="arc arc-1" d="M9.5 15.5a6 6 0 0 1 5 0"/>
                <circle class="dot" cx="12" cy="18.5" r="1.4"/>
              </svg>
            </div>
            <div id="dc-status"><span class="dot"></span><span class="label">Connecting…</span></div>
          </div>
        </div>
        <section id="dc-page-home" class="dc-page"></section>
        <section id="dc-page-service" class="dc-page"></section>
        <section id="dc-page-diagnostics" class="dc-page"></section>
        <section id="dc-page-log" class="dc-page">
          <div id="dc-log-toolbar">
            <button id="dc-log-clear" class="dc-btn">Clear</button>
            <!-- Plain link, no JS needed - components/log_ring_buffer/ (a
                 local ESPHome component, same pattern as this project's
                 own web_server_idf fork) serves a RAM-only ring buffer of
                 recent log lines at this URL with a Content-Disposition:
                 attachment header, so the browser just downloads it like
                 any other file link. Independent of "Clear" above (which
                 only clears what THIS tab has rendered from SSE) and of
                 whatever's currently on screen - always the device's own,
                 separately-kept copy since last boot. #dc-log-toolbar
                 .dc-btn (dashboard.css) already sizes this to content,
                 same as the Clear button, no dc-btn-compact needed. -->
            <a id="dc-log-download" class="dc-btn" href="/log.txt">Download Log</a>
          </div>
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
