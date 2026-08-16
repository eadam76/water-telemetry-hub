/* Water Data Collector - custom dark dashboard.
 *
 * Replaces the stock ESPHome web_server v3 app (hidden via dashboard.css)
 * with a small, self-contained UI built around what this device actually
 * does. Talks only to ESPHome's existing, stable REST/SSE API (documented
 * at https://esphome.io/web-api/) - no external requests, no build step.
 *
 * Four fixed pages, not one tab per sorting_group - internal page ids
 * ("service"/"diagnostics", element ids, function names like
 * ensureServiceGroup()/upsertDiagRow()) are unchanged from when these
 * were more literally what they say; only the NAV LABELS were renamed
 * (2026-08-15) once what each page actually shows had drifted from that:
 *   - Home     - the meters' own readings (what the device is *for*)
 *   - Devices  ("service" internally) - now just the unified pressure
 *              sensor + pulse meter table (calibration fields live inside
 *              each row's own expanded edit view, not a separate list
 *              here anymore - see the "Devices table" section below)
 *   - System   ("diagnostics" internally) - everything else about the
 *              unit itself: network/system diagnostics as plain label/
 *              value rows, PLUS the device-level action buttons (Reboot
 *              Device, Forget Wi-Fi) that don't belong to any one row in
 *              the Devices table - see upsertDiagButton() and render()'s
 *              own special-case for those two.
 *   - Log      - live debug output
 *
 * Which page an entity lands on by default is driven by its `domain` and
 * `entity_category` from the YAML (see pageFor()) - adding a new sensor
 * just works here without touching this file, as long as it's tagged the
 * same way (no entity_category for a primary reading, `entity_category:
 * diagnostic` for raw/debug data, `entity_category: config` for
 * calibration/actions). A handful of entities (the Debug Log switch,
 * Reboot Device, Forget Wi-Fi) are matched by name in render() instead,
 * to override that default when it's not where the entity should
 * actually be shown - their entity_category in the YAML is left alone
 * (still correct for Home Assistant's own categorization), this is
 * purely a dashboard-local placement choice.
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
  // Update/Reboot Device deliberately have no entry here (CR #3 in the
  // previous round): the confirm dialog they already show on press
  // explains the consequence right when it matters - a permanent "?" next
  // to them was redundant clutter, not help.
  const HELP_TEXT = {
    "Total Consumption": "Cumulative water use, calculated from the pulse count and the last calibration - not a live meter photograph.",
    "Flow Rate": "Instantaneous flow, based on the time between the last two pulses. Drops to 0 automatically after Zero-Flow Timeout with no new pulses.",
    "Reading": "Enter the physical meter's current reading here, then press Update to apply it. Typing here alone changes nothing.",
    "Zero-Flow Timeout": "How long with no pulses before Flow Rate is shown as 0. Lower reacts faster; higher tolerates slow trickles without a false zero.",
    "Display Name": "Shown instead of the fixed name above, on the Dashboard page and here.",
    // Keyed "Broker"/"Topic Prefix", NOT "MQTT Broker"/"MQTT Topic
    // Prefix" - direct feedback, 2026-08-16, tracked down a real bug
    // this caused: this map is keyed by displayName()'s STRIPPED label
    // (see this const's own comment above), and every MQTT entity's
    // group is itself named "MQTT" - so displayName() strips "MQTT "
    // off "MQTT Broker" etc. the exact same way it strips "Pulse Meter
    // 1 " off "Pulse Meter 1 Display Name" elsewhere. The full-name keys
    // that used to be here never matched anything, silently dropping
    // these two fields' help text - same root cause broke several other
    // MQTT-specific special-cases below (see upsertServiceSwitch()'s
    // "Enabled" check and mqttEntity() further down for the fuller
    // writeup).
    "Broker": "Host, host:port, or scheme://host:port (e.g. \"homeassistant.local\" or \"homeassistant.local:1884\"). No port given defaults to 1883. MQTT-over-TLS (mqtts://) isn't implemented - a scheme prefix is accepted but doesn't change how the connection is made.",
    "Topic Prefix": "Every topic this device publishes/subscribes to starts with this, followed by \"/\". Defaults to the device's own name.",
    // Forget Wi-Fi deliberately has no entry here either, same reasoning as
    // Update/Reboot Device (CR #3, previous round): its confirm dialog
    // already explains the consequence when it matters - a permanent "?"
    // would just be redundant clutter, and (found this round) also threw
    // off this button's row width relative to Reboot Device's plain one.
  };

  // The exact placeholder water-collector.yaml's "MQTT Password" field
  // publishes when a password is stored but not currently being edited -
  // see that field's own comment for why this couldn't just be
  // mode: password (ESPHome's own web_server masks a mode: password
  // field's *actual* value unconditionally, which would make "nothing
  // set" and "something set" look identical from here). Kept as one
  // named constant, not a literal repeated in two places, so the
  // firmware and dashboard.js can't silently drift out of sync.
  const MQTT_PASSWORD_PLACEHOLDER = "••••••••";

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
    // Password reveal toggle (upsertServiceText()'s "MQTT Password"
    // special-case below) - standard eye/eye-with-slash pair.
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff:
      '<path d="M3 3l18 18"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M6.6 6.7C4.1 8.4 2 12 2 12s3.5 7 10 7a10 10 0 0 0 3.4-.6M17.4 17.4C19.9 15.7 22 12 22 12a17 17 0 0 0-4-4.9"/>',
    // Header MQTT status icon (updateMqttStatusIcon() below) - the real
    // MQTT project logo (broadcast arcs fanning from the bottom-left
    // corner), not a hand-drawn approximation - direct feedback,
    // 2026-08-16: the first attempt (redrawn in this app's own thin-
    // stroke style from the user's own reference screenshot) looked
    // "blurry"/low quality at the small 17px header size, which thin
    // strokes on curved arcs are genuinely prone to. This is the exact,
    // official path data from the Simple Icons project (simpleicons.org,
    // slug "mqtt" - MIT/CC0-licensed icon set, fetched via `npm pack
    // simple-icons` since the direct CDN was blocked by this sandbox's
    // network policy), a solid fill shape rather than a stroked outline -
    // see the matching fill-based override on #dc-mqtt-status svg in
    // dashboard.css, since every other icon in this file is stroke-based
    // and needs the opposite treatment.
    mqttNode:
      '<path d="M10.657 23.994h-9.45A1.212 1.212 0 0 1 0 22.788v-9.18h.071c5.784 0 10.504 4.65 10.586 10.386Zm7.606 0h-4.045C14.135 16.246 7.795 9.977 0 9.942V6.038h.071c9.983 0 18.121 8.044 18.192 17.956Zm4.53 0h-.97C21.754 12.071 11.995 2.407 0 2.372v-1.16C0 .55.544.006 1.207.006h7.64C15.733 2.49 21.257 7.789 24 14.508v8.291c0 .663-.544 1.195-1.207 1.195ZM16.713.006h6.092A1.19 1.19 0 0 1 24 1.2v5.914c-.91-1.242-2.046-2.65-3.158-3.762C19.588 2.11 18.122.987 16.714.005Z"/>',
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
  // All 8 pressure sensor slots ("Pressure Sensor 1".."8" - see
  // packages/pressure_sensor.yaml) share one icon too, same reasoning as
  // the water meters above - matched by prefix instead of 8 literal map
  // entries, since which slot number is used isn't meaningful by itself.
  function groupIcon(name) {
    if (GROUP_ICON_BY_NAME[name]) return GROUP_ICON_BY_NAME[name];
    if (name.startsWith("Pressure Sensor")) return "gauge";
    return "dot";
  }
  // ids stay "home"/"service"/"diagnostics" internally (localStorage key,
  // #dc-page-* element ids, routing/function names throughout this file) -
  // only the displayed labels changed: "home" -> "Dashboard" per the "Show
  // on Dashboard" naming below (so the toggle's own name and the page it
  // controls visibility on match each other), and "service"/"diagnostics"
  // -> "Devices"/"System" (2026-08-15, direct feedback: "Service" had
  // drifted into meaning just the unified Devices table, and once the
  // device-level action buttons moved onto "Diagnostics" too - see this
  // file's own header comment - "Diagnostics" undersold what that page
  // now does, "System" covers both the readouts and the actions).
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
  // the wrong thing. Every other group's raw name (Pulse Meter 1,
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

  // Narrower than initialSettled, and NOT the same guard: initialSettled
  // is one-time and permanent, so once it flips true it no longer
  // distinguishes "this render was triggered by a genuinely new scan"
  // from "this render just happens to be running after settle, for some
  // completely unrelated reason (e.g. a routine pressure-sensor poll)".
  // The latter still reads whatever "Scan Results"/"Scan Collisions"
  // currently hold - which, if no scan has happened yet THIS session,
  // is still the stale pre-session value initialSettled was supposed to
  // hide. Confirmed in the field, 2026-08-15: the "Collision" note
  // survived a page refresh with no bus check in sight. This flag only
  // goes true when one of those two entities actually receives an
  // update while initialSettled is already true, i.e. a real scan this
  // session - see renderPressureEntity()'s "Scan Results"/"Scan
  // Collisions" branch, the only place this is set.
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

  // --- Diagnostics ("System") page: grouped label/value rows, plus a
  // `fields` area for the handful of device-level action buttons that
  // moved here from the Devices page (Reboot Device, Forget Wi-Fi - see
  // the special-case in render() and upsertDiagButton() below). Mirrors
  // ensureServiceGroup()'s own `fields` container/styling (.dc-fields/
  // .dc-field are generic, not scoped to .dc-service-group) rather than
  // inventing a second, near-identical button layout.

  // Three sub-areas per group, all optional-in-practice (only actually
  // populated once something upserts into them): `list` (plain read-only
  // label/value rows, the page's original purpose), `actions` (compact,
  // intrinsically-sized buttons in a flex row - Reboot Device/Forget
  // Wi-Fi), `fields` (proper bordered .dc-field cards with real inputs -
  // added 2026-08-15 for MQTT's settings, same layout/CSS the Devices
  // page's own generic field list already uses, just capped to the same
  // max-width via .dc-fields-capped rather than relying on a parent
  // .dc-service-group - this page never had that cap).
  const diagGroups = new Map(); // groupName -> { weight, section, list, actions, fields }

  function ensureDiagGroup(name) {
    let g = diagGroups.get(name);
    if (g) return g;
    const section = el("div", "dc-diag-group");
    const label = el("div", "dc-section-label", groupLabel(name));
    const list = el("div", "dc-list");
    const actions = el("div", "dc-diag-actions");
    // The "MQTT" group's fields lay out as a 2-column grid (Broker/Topic
    // Prefix full-width, Username/Password paired) instead of the
    // generic one-field-per-row stack every other group uses - direct
    // feedback, 2026-08-15, "az URL egy sorban, a következő sor pedig
    // user/pass" (the URL on one line, the next line Username/Password).
    // See .dc-fields-mqtt/.dc-field-span-2 in dashboard.css, and
    // upsertServiceText()'s own matching special-case for which fields
    // get the span class.
    const fieldsClass = name === "MQTT" ? "dc-fields dc-fields-capped dc-fields-mqtt" : "dc-fields dc-fields-capped";
    const fields = el("div", fieldsClass);
    section.append(label, list, actions, fields);
    g = { weight: groupWeights.get(name) ?? 500, section, list, actions, fields };
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

  // "Reboot Device"/"Forget Wi-Fi" - device-level action buttons that
  // render here instead of upsertServiceButton()'s Devices-page list, see
  // render()'s own special-case for why (2026-08-15, direct feedback: the
  // Devices page had become just the Devices table in every way but name,
  // so system-level actions - which aren't about any one device - moved
  // to sit alongside the rest of the "System" diagnostics they act on).
  //
  // Deliberately NOT wrapped in a bordered .dc-field card the way a
  // Devices-page button is (contrast upsertServiceButton()) - a first
  // version reused that exact layout and the button ended up stretched
  // (.dc-btn's own width: 100%) across the FULL page width, since
  // .dc-diag-group (unlike .dc-service-group) has no max-width - looked
  // clearly wrong, confirmed 2026-08-15. Rendered instead as a plain,
  // intrinsically-sized (.dc-btn-compact) button directly in a flex row
  // (.dc-diag-actions below), same weight class as the toolbar buttons on
  // the Devices page - neither of these two has HELP_TEXT anyway (see
  // that map's own comment), so there's no help-icon layout to preserve.
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

  // Whether the "MQTT Settings" button (ensureMqttHeader() below) has the
  // connection-fields card open - purely client-side UI state. Reset to
  // closed whenever "MQTT Enabled" turns off (updateMqttEnableButton()
  // below) - once the whole group of components hides, there's nothing
  // left open to remember.
  let mqttSettingsOpen = false;

  // The "MQTT" group's own bespoke header row - REPLACES the generic
  // .dc-list "Status" row (upsertDiagRow) and the toggle-pill "MQTT
  // Enabled"/"MQTT Connect" fields (upsertServiceSwitch) this group used
  // to render through. Left side: a "Status" caption, then three buttons
  // below it - Enable/Disable (always shown), and Connect/Disconnect +
  // "MQTT Settings" (shown only once Enabled is on - direct feedback,
  // 2026-08-16: "Az enabled csak annyit kell csináljon hogy bekapcsolja a
  // komponenseket (settings, connect/disconnect, sttings dialog)" -
  // Enabled should only turn the components on: settings, connect/
  // disconnect, settings dialog). Right side: the live status value.
  // Built once; the switch/text_sensor updates below
  // (updateMqttEnableButton()/updateMqttConnectButton()/
  // updateMqttStatusText()) just fill in already-existing pieces of it,
  // same "skeleton built once, upserted into" pattern used throughout
  // this file (e.g. upsertRegisteredPulseMeterRow()'s expand row).
  function ensureMqttHeader(group) {
    if (group.mqttHeader) return group.mqttHeader;
    const header = el("div", "dc-mqtt-header");
    const left = el("div", "dc-mqtt-header-left");
    left.appendChild(el("span", "dc-mqtt-header-caption", "Status"));
    const buttons = el("div", "dc-mqtt-header-buttons");
    const enableBtn = el("button", "dc-btn dc-btn-compact", "Enable");
    enableBtn.type = "button";
    const connectBtn = el("button", "dc-btn dc-btn-compact", "Connect");
    connectBtn.type = "button";
    const settingsBtn = el("button", "dc-btn dc-btn-compact", "MQTT Settings");
    settingsBtn.type = "button";
    settingsBtn.addEventListener("click", () => {
      mqttSettingsOpen = !mqttSettingsOpen;
      updateMqttFieldsVisibility();
    });
    buttons.append(enableBtn, connectBtn, settingsBtn);
    left.appendChild(buttons);
    const right = el("div", "dc-mqtt-header-right");
    header.append(left, right);
    // Between `list`/`actions` (both empty for this group now) and
    // `fields` (the settings card) - group.section's own child order.
    group.section.insertBefore(header, group.fields);
    group.mqttHeader = header;
    group.mqttEnableBtn = enableBtn;
    group.mqttConnectBtn = connectBtn;
    group.mqttSettingsBtn = settingsBtn;
    group.mqttStatusEl = right;
    return header;
  }

  // "MQTT Enabled"'s own button text/pressed-look - not a toggle-pill
  // anymore (see ensureMqttHeader() above) - the click handler is wired
  // once, here, closing over this SAME entity object (mutated in place
  // on every later update, same convention every other click handler in
  // this file relies on - e.g. upsertServiceSwitch()'s own toggle). Also
  // the one place that shows/hides the Connect/Disconnect and "MQTT
  // Settings" buttons - see this function's own header comment above.
  function updateMqttEnableButton(entity, group) {
    if (!group.mqttEnableWired) {
      group.mqttEnableBtn.addEventListener("click", () => {
        fetch(`${entity.namePath}/toggle`, { method: "POST" });
      });
      group.mqttEnableWired = true;
    }
    const on = entity.value === true;
    group.mqttEnableBtn.textContent = on ? "Disable" : "Enable";
    group.mqttEnableBtn.classList.toggle("dc-btn-active", on);
    group.mqttConnectBtn.hidden = !on;
    group.mqttSettingsBtn.hidden = !on;
    if (!on) mqttSettingsOpen = false;
    updateMqttFieldsVisibility();
  }

  // "MQTT Connect"'s own button text/pressed-look - the actual connect/
  // disconnect action, direct feedback, 2026-08-16: "legyen egy connect/
  // disconnect gomb (állapottól függően)" (there should be one connect/
  // disconnect button, depending on state). Same wire-once-close-over-
  // entity pattern as updateMqttEnableButton() above.
  function updateMqttConnectButton(entity, group) {
    if (!group.mqttConnectWired) {
      group.mqttConnectBtn.addEventListener("click", () => {
        fetch(`${entity.namePath}/toggle`, { method: "POST" });
      });
      group.mqttConnectWired = true;
    }
    const on = entity.value === true;
    group.mqttConnectBtn.textContent = on ? "Disconnect" : "Connect";
    group.mqttConnectBtn.classList.toggle("dc-btn-active", on);
  }

  // "MQTT Status" text_sensor's own value, straight into the header
  // row's right-hand side - no special formatting, the string itself
  // ("Connecting…"/"Connected"/"Connection lost - ..."/"Disconnected"/
  // "Disabled") is already meant to be read directly (see
  // packages/mqtt.yaml's own comments on that entity for what publishes
  // each one).
  function updateMqttStatusText(entity, group) {
    group.mqttStatusEl.textContent = entity.value || "";
  }

  // A single "Save" button at the bottom of the settings card - direct
  // feedback, 2026-08-16: "ennek az alján Save vagy OK gomb becsukja a
  // blokkot" (at the bottom of this, a Save or OK button closes the
  // block). Purely a UI action, no server round-trip of its own: every
  // field in the card already commits its own value on change (each
  // one's own set_action, same "commit per field, not per keystroke"
  // pattern as Reading/Update etc. elsewhere) - Save's only job is
  // closing mqttSettingsOpen back down. If MQTT is already Enabled and
  // you want a just-edited Broker/Username/Password to actually take
  // effect on the live connection, Disable then Enable again applies it
  // (matches how the whole app treats "these fields, this action" as two
  // separate, deliberate steps rather than instant-on-every-keystroke).
  function ensureMqttSaveButton(group) {
    if (group.mqttSaveBtn) return;
    const saveBtn = el("button", "dc-btn dc-field-span-2", "Save");
    saveBtn.type = "button";
    saveBtn.dataset.weight = "1000";
    saveBtn.addEventListener("click", () => {
      mqttSettingsOpen = false;
      updateMqttFieldsVisibility();
    });
    group.fields.appendChild(saveBtn);
    group.mqttSaveBtn = saveBtn;
    reorderServiceFields(group);
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

  // Pulse meter counterpart of registeredPressureSlots() - every
  // currently-Registered meter with its own Sort Order (added
  // 2026-08-13, "Devices" table unification - see water_meter.yaml's own
  // copy of that entity). No `address`/`online` here - a local GPIO
  // pulse counter has neither concept, see upsertRegisteredPulseMeterRow().
  function registeredPulseMeterSlots() {
    const slots = [];
    for (const groupName of pulseMeterGroups()) {
      if (!isPulseMeterRegistered(groupName)) continue;
      const orderEntity = pulseMeterSlotEntity(groupName, "Sort Order");
      slots.push({ groupName, order: orderEntity ? Math.round(orderEntity.value || 0) : 0 });
    }
    return slots;
  }

  // Every registered device, of EITHER type, in one shared display order -
  // the unified "Devices" table's own join (2026-08-13). Sort Order,
  // when customized (non-zero), wins first; ties among still-
  // uncustomized (order === 0)
  // devices fall back to plain groupName comparison, which happens to
  // already put "Pressure Sensor" before "Pulse Meter" (alphabetical) -
  // arbitrary but deterministic and stable across renders, which is all
  // that's actually needed here (a real tie only ever happens for
  // devices nobody has ever manually reordered anyway).
  function orderedRegisteredDevices() {
    const list = [
      ...registeredPressureSlots().map((s) => ({ type: "pressure", groupName: s.groupName, order: s.order, address: s.address, online: s.online })),
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

  let deviceTableBody = null;
  let deviceToolbarEl = null;
  const DEVICE_TABLE_GROUP = "Devices";

  // Registers the unified "Devices" group as a normal serviceGroups entry
  // (reusing reorderServiceGroups()'s existing weight-based interleaving
  // with the meter/system sections, for free) but with a bespoke body -
  // the table itself, with a small toolbar BELOW it (Add Pulse Meter/Add
  // Modbus Device, then Scan Bus - 2026-08-13, direct feedback: the
  // toolbar used to sit above the table with Scan Bus first; both moved,
  // see mountDeviceAddButtons()'s own comment for the ordering) - instead
  // of the generic .dc-fields list - built once, on first use.
  //
  // 2026-08-13, "Devices" table unification: replaces the two previously
  // separate tables (ensurePressureTable()/ensurePulseMeterTable()) with
  // one shared table listing every device of either type - Modbus
  // pressure sensors and local GPIO pulse meters - side by side, sorted
  // by the same cross-type Sort Order (orderedRegisteredDevices() above).
  // DEVICE_TABLE_GROUP is a purely client-side bucket key (like
  // PULSE_METER_ANCHOR_GROUP used to be for its own table), not a real
  // firmware sorting_group name - positioned using whichever real
  // group's weight is known (pulse meters' anchor group sits first in
  // water-collector.yaml's own sorting_groups list, so it's tried first).
  function ensureDeviceTable() {
    let g = serviceGroups.get(DEVICE_TABLE_GROUP);
    if (g) return deviceTableBody;
    const section = el("div", "dc-service-group dc-pressure-group");
    // No "Devices" section label here (removed 2026-08-15, direct
    // feedback: it's the ONLY section on this page, right below a page
    // title that already says "Devices" - a plain duplicate, not a
    // useful heading). If a second section ever gets added to this page,
    // this one may need a label back, but that's not the case today.
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
    // Card wrapper around BOTH the table and the toolbar (2026-08-13,
    // redesign pass) - one continuous bordered/rounded surface, toolbar
    // separated from the table only by a hairline (dashboard.css), not a
    // second freestanding card floating below the first. toolbar AFTER
    // tableScroll (below the table, not above) - direct feedback,
    // 2026-08-13.
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

  // The client-only "Add Pulse Meter" toggle - unlike Scan Bus (a real
  // firmware button entity), it has no entity of its own at all: it just
  // opens the in-table Add row below (buildDeviceAddRow()), which is what
  // actually talks to the device once its fields are filled in. There
  // used to be a second, matching "Add Modbus Device" button (2026-08-13)
  // opening a manual, hand-typed-address sub-form - removed the same day,
  // direct feedback: it caused more trouble than it solved (see the
  // duplicate-address hard-block added to the edit-save flow below, and
  // REQUIREMENTS.md's own writeup) - adding a Modbus device is scan-only
  // again, exactly like before that button ever existed. Built once,
  // lazily, from ensureDeviceTable() - always BEFORE Scan Bus can
  // possibly mount (that only happens once its own entity has arrived
  // over SSE, strictly later than this synchronous call), so a plain
  // append here is enough to guarantee the final toolbar order (Add
  // Pulse Meter, then Scan Bus) without needing an insertBefore anchor
  // dance the other way.
  let addPulseBtn = null;
  function mountDeviceAddButtons() {
    if (addPulseBtn) return;
    addPulseBtn = el("button", "dc-btn dc-btn-compact", "Add Pulse Meter");
    addPulseBtn.type = "button";
    addPulseBtn.addEventListener("click", () => toggleDeviceAdd());
    deviceToolbarEl.append(addPulseBtn);
  }

  // Opens the Add row, or closes it if already open (a second click =
  // cancel). Also force-cancels whichever row is currently mid-edit, if
  // any - direct feedback, 2026-08-13: starting a new Add should close
  // out an in-progress edit, the same "only one interactive thing open
  // at a time" rule the edit lock (deviceEditingRow) already enforces
  // between rows - see closeDeviceAddRow() below for the reverse
  // direction (entering edit closes a currently-open Add).
  function toggleDeviceAdd() {
    if (deviceEditingRow && deviceEditingRow._cancelEdit) deviceEditingRow._cancelEdit();
    deviceAddOpen = !deviceAddOpen;
    renderDeviceTableBody();
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

  // The real "Find Modbus Devices" button (water-collector.yaml -
  // rs485_modbus::scan_bus(); renamed from "Scan Bus" 2026-08-15, direct
  // feedback: "Scan Bus" didn't read as clearly as what the button
  // actually does) - a plain button mounted into the toolbar below the
  // table, same wiring as a generic Service field but without pulling in
  // ensureServiceGroup()'s .dc-fields layout. Deliberately NOT routed
  // through the shared pressButton() (its brief ".dc-pressed" flash
  // doesn't fit a ~6s operation) - disabled + relabeled "Scanning…"
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
        // A fresh, deliberate scan supersedes any earlier session-local
        // dismissal (dismissDeviceAddRow.../dismissedScanAddresses below)
        // - the user explicitly asked to see the bus's current state
        // again, not whatever was previously waved away.
        dismissedScanAddresses.clear();
        fetch(`${entity.namePath}/press`, { method: "POST" });
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

  // Shared across BOTH device types (2026-08-13, "Devices" table
  // unification) - "reg:"+groupName (either type), "new:"+address or
  // "collision:"+address (pressure only - see below) -> <tr>. groupNames
  // never collide across types ("Pressure Sensor N" vs "Pulse Meter N"),
  // so one shared Map is safe.
  const deviceTableRows = new Map();
  const pressureNewRowDrafts = new Map(); // address -> in-progress typed name, kept across re-renders until Add/rescan
  // The one registered row (of EITHER type) currently in edit mode (its
  // own expanded detail row attached below it), or null - see enterEdit()
  // in each type's own upsertRegistered*Row() for why only one can ever
  // be open at a time, table-wide. Replaces the pulse-meter-only
  // pulseMeterEditingRow this used to be - pressure rows now use the same
  // single-editor lock and expand-row pattern (Modbus Address moved out
  // of the main row into the expand area, mirroring Reading/Zero-Flow
  // Timeout), so the lock has to be shared to actually mean "only one
  // open, whole table" rather than "only one open per type".
  let deviceEditingRow = null;

  // A registered pressure slot's row. Status is normally this slot's own
  // live Online value (OK/Lost), but a collision seen at this exact
  // address in the last scan overrides that - a garbled reply is a much
  // more specific, actionable signal ("something else is answering to
  // your address too") than a plain Lost, so it takes priority over
  // whatever the last poll happened to see.
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
  // Name is read-only until the row's own pencil button is pressed, then
  // editable with an explicit Save/Cancel - previously Name+Address wrote
  // on every blur (a plain HTML `change` event), which made it
  // dangerously easy to fire a real reprogram (Address really does
  // rewrite the physical sensor - see pressure_sensor.yaml's Modbus
  // Address set_action) just by tabbing through the row or clicking
  // elsewhere mid-edit. Confirmed too easy to trigger by accident on real
  // use, 2026-08-13.
  //
  // Modbus Address itself moved out of the main row (2026-08-13, "Devices"
  // table unification - the user's own request: a shared Name/Status/
  // Edit/Delete/Order column set across both device types, with Modbus
  // Address, of that whole set, only being editable at all) into an
  // expand row below, only present while editing - the exact same
  // pattern the pulse meters' own Reading/Zero-Flow Timeout already used
  // (upsertRegisteredPulseMeterRow() below), now shared table-wide.
  function upsertRegisteredPressureRow(tbody, groupName, online, hasCollision, isFirst, isLast) {
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
      nameRow.appendChild(el("span", "dc-device-type-icon", svgIcon("gauge")));
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
      saveBtn.addEventListener("click", () => {
        // A blank Display Name doesn't just look empty - groupLabel()'s
        // own fallback (dashboard.js's shared home/section-header logic)
        // falls straight through to the group's raw compile-time id
        // (e.g. "Pressure Sensor 3") the moment the stored name is
        // empty, exactly the internal, deliberately-meaningless string
        // this whole file goes out of its way to never show elsewhere.
        // The Add flow already requires a name before it would even fire
        // (buildDeviceAddRow()); confirmed on real hardware, 2026-08-13,
        // that editing an existing row back to blank was still wide open
        // to the same problem - required here too.
        if (!nameInput.value.trim()) {
          alert("Name can't be empty.");
          return; // stay in edit mode so it can be fixed
        }
        const parsed = parseInt(addrInput.value, 10);
        if (Number.isNaN(parsed) || parsed < 1 || parsed > 247) {
          alert("Address must be a number between 1 and 247.");
          return; // stay in edit mode so the value can be fixed
        }
        // Hard block, not a dismissable confirm() - this is the path that
        // actually reprograms a real, already-registered physical sensor
        // (change_address_and_save(), rs485_modbus.h), so setting it to an
        // address another registered slot already claims causes a genuine
        // electrical/protocol bus collision, not just a bookkeeping clash.
        // Confirmed in the field, 2026-08-15: recovering from that needed
        // physically disconnecting and reconnecting hardware. A soft,
        // click-through warning here is not an acceptable safeguard.
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
  // (it's whatever the scan found, shown as a small hint above the name
  // field - the standalone Address column is gone, 2026-08-13, "Devices"
  // table unification, folded into the Name cell instead, same as the
  // collision row below), Name is a local draft (nothing is written to
  // the device until confirmed), Status is always "New". Confirm sets the
  // umbrella group's shared Add Name/Add Target Address scratch entities
  // and presses its shared Add button - see that button's own comment in
  // water-collector.yaml for why one shared trigger behind 8 per-row
  // buttons (now also probed server-side first - see that same comment)
  // is safe and correct.
  //
  // Confirm/Dismiss are icon buttons (check/close), not a text "Add" -
  // 2026-08-13, direct feedback: visually consistent with the rest of the
  // table's action icons rather than a standalone button that looked like
  // a second, different kind of control. Dismiss doesn't talk to the
  // device at all - it only hides this one address from view for the
  // rest of THIS session (dismissedScanAddresses below), cleared by the
  // next actual Scan Bus press (mountPressureToolbarButton()'s own click
  // handler) - explicit feedback, 2026-08-13: a mere scan (and dismissing
  // one of its results) shouldn't be a persistent action, so a page
  // reload/reconnect starts clean rather than re-showing what was
  // dismissed or, for that matter, any stale scan at all - see
  // renderDeviceTableBody()'s own initialSettled gate for the other half
  // of that same requirement.
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
      nameRow.appendChild(el("span", "dc-device-type-icon", svgIcon("gauge")));
      const nameContent = el("div", "dc-pressure-name-content");
      nameRow.appendChild(nameContent);
      nameContent.appendChild(el("span", "dc-pressure-addr-hint", `Modbus address: ${address}`));

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
        if (!row._confirmBtn._busy) row._confirmBtn.disabled = atCeiling || !nameInput.value.trim();
      });
      nameContent.appendChild(nameInput);
      row._nameInput = nameInput;

      const actionCell = row.querySelector(".dc-pressure-action");

      // Disabled with no name typed - a device isn't necessarily a
      // pressure sensor (more Modbus device types are planned), so
      // silently falling back to a generic "Pressure Sensor N" label on
      // an empty name would be actively wrong for those, confirmed a
      // problem, 2026-08-13.
      const confirmBtn = el("button", "dc-pressure-icon-btn dc-pressure-save-btn", svgIcon("check"));
      confirmBtn.type = "button";
      confirmBtn.disabled = true;
      actionCell.appendChild(confirmBtn);
      confirmBtn.addEventListener("click", () => {
        if (confirmBtn.disabled) return;
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
        confirmBtn._busy = true;
        confirmBtn.disabled = true;
        fetch(`${nameEntity.namePath}/set?value=${encodeURIComponent(name)}`, { method: "POST" })
          .then(() => fetch(`${addrEntity.namePath}/set?value=${encodeURIComponent(address)}`, { method: "POST" }))
          .then(() => fetch(`${addEntity.namePath}/press`, { method: "POST" }))
          .finally(() => {
            confirmBtn._busy = false;
            confirmBtn.disabled = atCeiling;
          });
        pressureNewRowDrafts.delete(address);
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
      row._confirmBtn.disabled = atCeiling || nameEmpty;
      row._confirmBtn.title = atCeiling
        ? "All 8 sensor slots are already registered - delete one first to add another."
        : nameEmpty
          ? "Enter a name first."
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

  // Addresses a scan found but the user explicitly dismissed this session
  // (upsertNewPressureRow()'s own Dismiss icon) - session-local only, on
  // purpose (2026-08-13, direct feedback): cleared by the next real Scan
  // Bus press, and implicitly reset on a page reload too, since this is
  // never persisted anywhere (a plain in-memory Set, gone the moment this
  // tab's JS re-runs).
  const dismissedScanAddresses = new Set();

  function suppressStaleHover(tbody) {
    tbody.classList.add("dc-pressure-table-settling");
    document.addEventListener("mousemove", () => tbody.classList.remove("dc-pressure-table-settling"), { once: true });
  }

  // The actual JOIN (see this section's header comment) - rebuilt on
  // every relevant SSE update, for EITHER device type. Registered rows
  // are keyed by groupName (unique across both types) and scan-discovered
  // new-device/collision rows by address, all stable across rebuilds, so
  // an in-progress edit (name being typed, address being typed) survives
  // a rebuild triggered by something unrelated - see the activeElement
  // guards in upsertRegistered*Row()/the draft Maps above.
  //
  // 2026-08-13, "Devices" table unification: replaces the two previously
  // separate renderPressureTableBody()/renderPulseMeterTableBody() - one
  // shared reconciliation loop, called from both renderPressureEntity()
  // and renderPulseMeterEntity() (still separate dispatch entry points,
  // still triggered by their own respective entities' SSE updates - only
  // what they render into is now shared). Also owns the Add row's own
  // position (always LAST, whenever it's open, right above the toolbar
  // that opens it - moved from first to last the same day the toolbar
  // itself moved below the table, direct feedback, so the row stays
  // spatially close to the button that opened it) - the two type-specific
  // render loops didn't need this since neither used to have anything
  // pinned to a fixed position outside their own tracked rows.
  function renderDeviceTableBody() {
    const tbody = ensureDeviceTable();
    if (!tbody) return;
    refreshDeviceAddButtons();
    const registered = registeredPressureSlots();
    const registeredAddresses = new Set(registered.map((s) => s.address));
    const scanAddresses = latestScanAddresses();
    const collisionAddresses = latestCollisionAddresses();
    const collisionSet = new Set(collisionAddresses);
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
          i === 0,
          i === orderedRegistered.length - 1
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

    // Gated on scanResultsFresh, NOT initialSettled (see scanResultsFresh's
    // own comment further up) - direct feedback, 2026-08-13: merely
    // scanning the bus shouldn't be a persistent action, so a stale "Scan
    // Results"/"Scan Collisions" value already sitting on the device from
    // before THIS page load (or a previous session entirely) must not
    // resurrect "New device"/"Collision" rows just because some unrelated
    // render happens to run later. Only a genuinely fresh update - this
    // client's own scan press, or another client's, landing after the
    // initial dump has settled - should ever make these rows appear.
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

    // upsert*Row() above only appends a row to the DOM the first time
    // it's created - without this, every row would keep whatever
    // position it happened to be inserted at forever afterwards, even
    // once a Sort Order change (or a device getting registered/deleted
    // elsewhere in the list) says it belongs somewhere else.
    //
    // Only actually *moves* a row when it isn't already in the right
    // spot - unconditionally calling appendChild()/insertBefore() on
    // every row on every render (an earlier version of this loop) is
    // wrong even for rows that don't need to move at all: detaching and
    // reattaching a node blurs whatever input inside it currently has
    // focus. Since this whole function re-runs on every relevant SSE
    // update - which, for a registered pressure slot, includes its own
    // live Online status changing on essentially every poll, roughly
    // twice a second - that made editing a row's Name/Address effectively
    // impossible, confirmed on real hardware, 2026-08-13: focus kept
    // getting kicked out mid-edit by the *next* poll's own re-render, not
    // by anything about editing itself. This walks the desired order
    // once and only touches a node when its current position doesn't
    // already match - for the overwhelmingly common case (nothing was
    // just reordered) that's zero DOM moves.
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
    // A row disappearing (e.g. Delete) can leave a *different* row's icon
    // sitting exactly where the mouse cursor already was - the confirm()
    // dialog that gated the delete is a blocking native prompt, so the
    // click that led here never involved the mouse actually moving over
    // whatever's there now. Confirmed on real hardware, 2026-08-13: the
    // new first row's trash icon showed a stuck hover-red look until the
    // mouse was moved (or clicked elsewhere). suppressStaleHover() below
    // clears that until an actual pointer move happens.
    if (removedAny) suppressStaleHover(tbody);
    updateDeviceEmptyState(tbody, seenKeys.size === 0);
    resyncDeviceHomeCardOrder();
  }

  // --- The "Add" row (opened from the "Add Pulse Meter" toolbar button) --
  //
  // 2026-08-13, "Devices" table unification, since simplified back down:
  // there used to be a second flow here (manual "Add Modbus Device", a
  // hand-typed address, no scan involved) - removed the same day, direct
  // feedback: it caused more trouble than it solved (no protection at
  // all against typing an address another registered slot already used -
  // see the hard block added to the edit-save flow below for the actual
  // fix that replaced it) and wasn't needed anyway, since Modbus devices
  // are still addable the original way (a scan-discovered row's own
  // Confirm icon, upsertNewPressureRow() above). This row is Pulse Meter
  // -only now. A single in-table row (not a modal), consistent with
  // everything else in this table already living as rows. Built once,
  // lazily; its own DOM nodes persist across re-renders (only the slot
  // dropdown's options get touched on every renderDeviceTableBody() call,
  // and only when the underlying free-slot set actually changed - see
  // refreshDeviceAddRow()'s own comment for why that guard matters) so a
  // typed-but-not-yet-submitted name never gets blown away by an
  // unrelated background poll, same activeElement-safety reasoning as
  // every editable row in this file.
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

    // A slot picker instead of a free-typed address/id: there's no
    // discovery step at all here, just whichever of the (currently
    // exactly two) fixed GPIO slots isn't already Registered - see
    // refreshDeviceAddRow() below for how the option list is kept
    // current, and water_meter.yaml's own per-meter Add button for what
    // this actually fires. Labeled "IO 1"/"IO 2" (pulseSlotOptionLabel()
    // below), not the internal "Pulse Meter 1/2" group name - direct
    // feedback, 2026-08-13: that read as an odd, meaningless choice at
    // Add time; "IO N" matches what's actually printed on the board
    // itself next to the SH1.0 connector.
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 32;
    nameInput.placeholder = "Device name";
    nameInput.autocomplete = "off";
    const slotSelect = document.createElement("select");

    const errorEl = el("span", "dc-device-add-error", "");

    // Confirm/Cancel icon buttons - reuses the row's own Save/Cancel icon
    // pair (2026-08-13, direct feedback: visually consistent with every
    // other confirm/cancel action in this table, instead of a standalone
    // text "Add" button that looked like a different kind of control).
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

    // This row (and its inputs) is built once and reused for every open/
    // close cycle (see the `if (!deviceAddRow)` cache further down) - a
    // typed name that's never explicitly cleared just sits in the DOM
    // node and reappears next time the row reopens. Confirmed as a real
    // bug, 2026-08-15: add "pm1", confirm, reopen for the next slot - the
    // name field still says "pm1". Both exit paths (successful Add, and
    // Cancel) reset the form back to blank.
    const resetForm = () => {
      nameInput.value = "";
      errorEl.textContent = "";
    };

    const cancel = () => {
      deviceAddOpen = false;
      resetForm();
      renderDeviceTableBody();
    };
    cancelBtn.addEventListener("click", cancel);

    const confirm = () => {
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
      fetch(`${nameEntity.namePath}/set?value=${encodeURIComponent(name)}`, { method: "POST" })
        .then(() => fetch(`${addEntity.namePath}/press`, { method: "POST" }))
        .finally(() => {
          confirmBtn.disabled = false;
          deviceAddOpen = false;
          resetForm();
          renderDeviceTableBody();
        });
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

  // Refreshes the slot dropdown's options to whichever GPIO slots aren't
  // currently Registered (2026-08-13, direct feedback: offer only
  // whichever of the two fixed slots remains - not yet a generic "enable
  // more GPIOs" setup screen, deliberately deferred). Runs on every
  // render while the Add row is open - but only actually touches the
  // <select>'s DOM when the underlying free-slot set has changed
  // (row._slotKey below), not unconditionally. Rebuilding a <select>'s
  // options while it's open/focused (the previous version did this on
  // every single call) confirmed a real bug on real hardware, 2026-08-13:
  // the native dropdown popup got confused about its own content
  // changing out from under it and wouldn't reliably release focus
  // afterwards. The free-slot set only ever changes when a meter gets
  // Registered/Deleted elsewhere - genuinely rare while this row happens
  // to be open - so skipping the rebuild the rest of the time costs
  // nothing and fixes the bug outright.
  function refreshDeviceAddRow() {
    const row = deviceAddRow;
    const free = pulseMeterGroups().filter((g) => !isPulseMeterRegistered(g));
    const freeKey = free.join(",");
    if (row._slotKey !== freeKey) {
      row._slotKey = freeKey;
      const select = row._slotSelect;
      const prevValue = select.value;
      select.innerHTML = free.map((g) => `<option value="${g}">${pulseSlotOptionLabel(g)}</option>`).join("");
      if (free.includes(prevValue)) select.value = prevValue;
    }
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

  // Keeps the Home page's device cards - BOTH types - in the same order
  // as the unified Devices table's own (orderedRegisteredDevices(),
  // Sort Order-driven, 2026-08-13). Previously each card's position came
  // straight from its compile-time slot weight (raw declaration order in
  // water-collector.yaml), which never reflected the table's own Up/Down
  // reordering at all - confirmed a real gap, 2026-08-13: reordering on
  // the Service page had no visible effect on the Dashboard. Rewrites
  // each currently-existing device card's own cached weight to its rank
  // in that same order, offset by the block's own base weight (Pulse
  // Meter 1's original compile-time weight - the lowest of the two types'
  // - so the whole merged block still sits wherever that used to sit
  // relative to Network/System, only the order *within* the block
  // changes, now spanning both device types together, per direct
  // feedback, 2026-08-13, that Sort Order should keep driving the
  // Dashboard for pulse meters too). Called once per renderDeviceTableBody()
  // rather than from each type's own sync function separately, so either
  // type changing reorders both consistently from one place.
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

  // A registered meter's row, rendered into the SAME shared devices table
  // as the pressure rows (deviceTableRows/deviceEditingRow, declared
  // above upsertRegisteredPressureRow()) - Name is read-only until the
  // pencil button is pressed, then editable with an explicit Save/Cancel
  // (and Enter/Escape - see the pressure row's own comment for why), same
  // lock and for the same reason (an accidental blur used to write
  // immediately). No Add row of its own anymore (2026-08-13, "Devices"
  // table unification) - a not-yet-registered meter simply has no row at
  // all now, added instead through the shared Add row's own Pulse Meter
  // sub-form (buildDeviceAddRow() above), which is what the old
  // upsertNewPulseMeterRow() used to be.
  //
  // Status, revised 2026-08-15 (direct feedback: a pulse meter's badge
  // was always the single word "Ready" regardless of anything actually
  // happening - "csak ready (nem látom értelmét)", didn't see the point).
  // Deliberately still NOT the pressure slot's OK/Lost/Collision/Checking
  // set - a local GPIO pulse counter genuinely has no "unreachable"
  // failure mode to report (same reasoning as before, 2026-08-13) - but
  // now reflects actual flow instead of a constant word, using exactly
  // the signal the user's own suggestion pointed at ("mutatjuk hogy
  // aktív mert volt pulse, de amikor lenullázzuk a flow-t akkor
  // valamiféle várakozást mutatunk"): "Flowing" (status-good green)
  // while Pulse Rate is nonzero, "Idle" (neutral gray, the same tone as
  // Modbus's own "Checking…"/"New" - not the alarm-colored Lost, since
  // no flow is completely normal, not a fault) once the water_meter.yaml
  // zero-flow watchdog has zeroed it back out - see
  // updatePulseMeterStatus() below, driven off the "Pulse Rate" entity's
  // own value on every update. flashPulseMeterActivity() below still
  // layers its brief per-pulse ring on top of whichever of the two this
  // is showing - the two mechanisms answer different questions ("is flow
  // currently happening" vs. "did a pulse just land right now") and
  // read fine together.
  //
  // Reading/Update/Zero-Flow Timeout live in a second, detail <tr> that
  // only exists in the DOM while this row is being edited - opened by
  // the same pencil that unlocks Name, closed by the same Save/Cancel.
  // Direct feedback, 2026-08-13: these fields used to sit permanently in
  // their own always-visible Service section below the table (6 lines
  // for 2 real fields), and it wasn't obvious which fields belonged to
  // which meter; this both compacts the layout (2 lines total, label +
  // inline input(+button) each) and makes the grouping unambiguous (the
  // fields are physically inside the row they belong to, only visible
  // while that row is open).
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

      // Starts "Idle"/pending - the honest default before this meter's
      // own "Pulse Rate" update has arrived at all (every entity's state
      // is sent on connect, so in practice this is corrected within the
      // first SSE batch either way - see updatePulseMeterStatus() below).
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
    row._upBtn.disabled = !!isFirst;
    row._downBtn.disabled = !!isLast;
  }

  // Creates/removes this meter's Home card and Diagnostics section
  // (Total Pulses) as a whole, purely from its own Registered state -
  // the unified counterpart of syncPressureHomeCard(). Reading/Update/
  // Zero-Flow Timeout no longer have a separate Service-page section to
  // remove here at all (2026-08-13) - they live inline in the table
  // row's own expanded detail area instead (upsertRegisteredPulseMeterRow()'s
  // own comment), which is torn down and rebuilt fresh as part of the
  // row itself whenever the row goes away, with nothing left here to do
  // for them specifically.
  //
  // Still clears every cached DOM reference this file keeps on an entity
  // object (.el/.inputEl/.readoutEl/.toggleEl/.btnEl) when un-
  // registering, for whatever *does* still reach the generic dispatch
  // (Total Consumption/Flow Rate/Total Pulses) - without this, re-
  // Registering the same meter later would silently keep updating
  // detached, invisible nodes from before instead of rebuilding fresh
  // ones: the exact bug already found and fixed once for the pressure
  // sensors' own Home card (entity.el going stale across a remove-then-
  // recreate cycle).
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
      if (!row._readingWired) {
        input.addEventListener("change", () => {
          const parsed = parseFloat(input.value);
          const outOfRange =
            Number.isNaN(parsed) || (entity.min !== undefined && parsed < entity.min) || (entity.max !== undefined && parsed > entity.max);
          if (outOfRange) {
            input.value = entity.value ?? "";
            return;
          }
          fetch(`${entity.namePath}/set?value=${encodeURIComponent(input.value)}`, { method: "POST" });
        });
        row._readingWired = true;
      }
      if (document.activeElement !== input) input.value = entity.value ?? "";
    } else if (label === "Update") {
      if (!row._updateWired) {
        row._updateBtn.addEventListener("click", () => {
          const value = row._readingInput.value;
          const uom = entity.uom ? ` ${entity.uom}` : "";
          if (!confirm(`Set ${entity.groupName} Reading to ${value}${uom}? This overwrites the accumulated total and cannot be undone.`)) return;
          fetch(`${entity.namePath}/press`, { method: "POST" });
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
          fetch(`${entity.namePath}/set?value=${encodeURIComponent(input.value)}`, { method: "POST" });
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
  // Last "Total Pulses" value actually seen per meter, checked by
  // flashPulseMeterActivity()'s own caller below - see that call site's
  // comment for why this is needed, direct feedback, 2026-08-16.
  const lastSeenTotalPulses = new Map();

  // The "pulse just landed" ring on top of the steady status badge (see
  // upsertRegisteredPulseMeterRow()'s own comment - direct feedback,
  // 2026-08-13: distinguish "configured" from "a pulse is actually
  // arriving right now"). Driven off "Total Pulses" - the diagnostic,
  // always-sent readout of the persisted pulse_count (water_meter.yaml)
  // - which only ever INCREMENTS on a genuine accumulated pulse, not on a
  // timer. One caveat, accepted for now (see REQUIREMENTS.md): the very
  // first "Total Pulses" update right after Add/boot (seeding from the
  // persisted checkpoint, not a fresh pulse) also flashes once - harmless,
  // and self-corrects on the next real one.
  function flashPulseMeterActivity(groupName) {
    const row = deviceTableRows.get("reg:" + groupName);
    if (!row || !row._statusEl) return;
    const badge = row._statusEl;
    // Force-restart the CSS animation even if a pulse arrives while the
    // previous one is still mid-flash (real flow can easily be faster
    // than the ~0.6s animation) - re-adding a class that's already
    // present is a no-op in the DOM, so classList.add() alone wouldn't
    // retrigger anything. Removing the class, forcing a synchronous
    // layout read (the classic reflow trick - the read itself is what
    // matters, the discarded value is not used for anything else), then
    // re-adding it is what actually restarts a CSS animation on demand.
    badge.classList.remove("dc-pulse-flash");
    void badge.offsetWidth;
    badge.classList.add("dc-pulse-flash");
    clearTimeout(pulseFlashTimers.get(groupName));
    pulseFlashTimers.set(
      groupName,
      setTimeout(() => badge.classList.remove("dc-pulse-flash"), 600)
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
    row._statusEl.textContent = flowing ? "Flowing" : "Idle";
    row._statusEl.classList.toggle("dc-pressure-badge-ok", flowing);
    row._statusEl.classList.toggle("dc-pressure-badge-pending", !flowing);
  }

  // Pulse Rate/Total Pulses/Sort Order never get a System-page row -
  // direct feedback, 2026-08-15: raw/uncalibrated diagnostic clutter, one
  // per registered meter, with no counterpart for pressure sensors (which
  // never reach the System page at all - see renderPressureEntity() above)
  // to make the asymmetry worse. Each one's actual information already
  // shows up somewhere better: Pulse Rate/Total Pulses are the raw,
  // uncalibrated versions of Flow Rate/Total Consumption (Home/Devices
  // page); Sort Order's only real effect (row position) is already
  // visible in the Devices table itself, the raw counter behind it isn't
  // meaningful on its own. Still perfectly normal, disabled_by_default
  // entities for Home Assistant - this is purely a dashboard-local
  // suppression, same pattern as HIDDEN_FROM_DIAG-style filters
  // elsewhere in this file (e.g. isHiddenFromUi()).
  const HIDDEN_FROM_PULSE_DIAG = new Set(["Pulse Rate", "Total Pulses", "Sort Order"]);

  function renderPulseMeterCalibrationEntity(entity) {
    if (!isPulseMeterRegistered(entity.groupName)) return;
    const label = displayName(entity);
    // Bug, direct feedback, 2026-08-16: the status badge flashed even on
    // an Up/Down reorder (a "Sort Order" change), and sometimes on its
    // own at unpredictable moments - both traced to the SAME cause:
    // renderPulseMeterEntity() below re-runs every entity in this group
    // through this function on ANY of them changing (Sort Order, a
    // reorder; Pulse Rate, the zero-flow watchdog zeroing it out; etc),
    // not just when "Total Pulses" itself has a fresh value - so this
    // used to fire the flash on every one of those re-visits too, even
    // though Total Pulses hadn't actually moved. Fixed by only flashing
    // when the value genuinely differs from the last one actually seen.
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
      // Mirrors what upsertServiceText() does for every other renamed
      // group (water meters used to reach it directly for this same
      // entity, before Display Name was intercepted here) - this
      // group's Home card header has no other way to learn a renamed
      // Display Name, since it never reaches that generic path anymore.
      groupDisplayNames.set(groupName, (entity.value || "").trim());
      applyGroupLabel(groupName);
    }
    // Sort Order added to this gate 2026-08-13 ("Devices" table
    // unification) - a Up/Down press (moveDeviceRow()) needs to actually
    // trigger a re-render for the visual reorder to show up at all.
    if (label === "Registered" || label === "Delete" || label === "Display Name" || label === "Sort Order") {
      renderDeviceTableBody();
      syncPulseMeterVisibility(groupName);
    }
    // Unconditionally re-run *every* known entity in this group through
    // the calibration dispatch on *every* update, not just when
    // Registered/Delete/Display Name themselves change - mirrors
    // syncPressureHomeCard()'s own always-resync approach exactly, for
    // the same reason: ESPHome dumps entities in a fixed cross-domain
    // order, not registration order, so "Registered" (switch domain)
    // isn't guaranteed to arrive before e.g. "Total Consumption" (sensor
    // domain) - an entity whose own update arrived first used to be
    // silently skipped by the gate in renderPulseMeterCalibrationEntity()
    // and never revisited, confirmed on real hardware, 2026-08-13: newly
    // -added meters' Reading/Zero-Flow Timeout fields sometimes only
    // appeared after a full page reload. Redundant on most calls (the
    // underlying upsert*() functions are all cheap no-ops when nothing
    // actually changed) but removes any dependency on exact arrival
    // order entirely, rather than only patching the specific ordering
    // that happened to be observed.
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
  // pass ensureDiagGroup instead to render on the System page (added
  // 2026-08-15 for MQTT's settings; see also upsertServiceText()/
  // upsertServiceSwitch() below, same parameter for the same reason).
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
        fetch(`${entity.namePath}/set?value=${encodeURIComponent(input.value)}`, { method: "POST" });
      });
      entity.inputEl = input;
      // The MQTT password field - matched by name, not entity.mode (this
      // field is mode: text, deliberately not mode: password - see that
      // field's own comment in packages/mqtt.yaml for why). Masked by
      // default like any password input, with an eye toggle to reveal
      // what's currently typed (direct feedback, 2026-08-15) - purely a
      // local, client-side reveal of THIS input's current content, never
      // a request to the device for the real stored value (which this
      // dashboard never receives at all, on purpose).
      //
      // Checked against entity.groupName + the STRIPPED label ("Password"),
      // not the full "MQTT Password" - direct feedback, 2026-08-16, a
      // real bug: displayName() strips the group name as a prefix off
      // every entity's name (e.g. "Pulse Meter 1 Display Name" ->
      // "Display Name"), and this entity's group is itself named "MQTT" -
      // so `label` here was ALWAYS "Password", never "MQTT Password",
      // and this whole eye-toggle branch silently never ran. Same root
      // cause broke the "MQTT Enabled" collapse exemption and the
      // header status icon - see mqttEntity()'s own comment further
      // down for the fuller writeup of everywhere this hit.
      if (entity.groupName === "MQTT" && label === "Password") {
        input.type = "password";
        // Actively discourage the browser's own password-manager
        // suggestion/autofill UI on this field - direct feedback,
        // 2026-08-16 ("password mezőre tudjuk tiltani a jelszókezelő
        // felajánlását?"). autocomplete="new-password" (the previous
        // value here) is the OPPOSITE of what's wanted - that's the
        // standard hint sites use to specifically INVITE Chrome's "here's
        // a strong password" suggestion bubble, not suppress it. "off",
        // a `name` that doesn't look like a real account password field,
        // and the handful of third-party manager-specific ignore
        // attributes below are the most a plain masked input can do
        // without giving up native `type="password"` masking entirely -
        // no single attribute reliably suppresses every manager in every
        // browser.
        input.autocomplete = "off";
        input.name = "mqtt-broker-secret";
        input.setAttribute("data-lpignore", "true"); // LastPass
        input.setAttribute("data-1p-ignore", "true"); // 1Password
        input.setAttribute("data-bwignore", "true"); // Bitwarden
        input.setAttribute("data-form-type", "other"); // generic heuristic managers
        // The resting value is either "" or the fixed dots placeholder
        // (never the real password) - clearing on focus means typing
        // always starts fresh, instead of the browser inserting new
        // characters into/before the placeholder text.
        input.addEventListener("focus", () => {
          if (input.value === MQTT_PASSWORD_PLACEHOLDER) input.value = "";
        });
        // Explicit state, not re-derived from input.type on every click
        // (direct feedback, 2026-08-16: "néha tudok beírni, de nem látom
        // a logikát" - sometimes I can type in, but I don't see the
        // logic behind it) - a plain boolean can't drift out of sync
        // with what's actually on screen. Icon reflects the CURRENT
        // visibility, per the user's own direct correction ("szerintem
        // fordítva van a csukott/nyitott szem" - I think the closed/open
        // eye is backwards): a closed/crossed eye while masked (nothing
        // to see right now), a plain open eye while revealed (you're
        // looking at it right now) - swapped from the previous version.
        let revealed = false;
        const eyeBtn = el("button", "dc-field-eye-btn", svgIcon("eyeOff"));
        eyeBtn.type = "button";
        eyeBtn.setAttribute("aria-label", "Show password");
        // THE actual "totally broken" bug, direct feedback, 2026-08-16:
        // "Ha beírom a jelszót rejtve majd megnyomom a szemet akkor
        // írja ki a jelszót" (if I type the password hidden then press
        // the eye, it writes the password out) - clicking any other
        // focusable element moves focus away from `input` by default,
        // which fires its `change` handler (this field's own set_action
        // above) - so pressing the eye button was PREMATURELY
        // submitting whatever had just been typed, mid-edit, before the
        // user asked for that - the device's own SSE echo back (a fixed
        // "" or the dots placeholder, per this field's own comment,
        // never the real value) would then overwrite the input's visible
        // content moments later, which is what actually looked like
        // "writes the password" from the outside. preventDefault() on
        // the button's own mousedown - not click - is the standard fix:
        // it stops the browser from shifting focus away from `input` at
        // all when this button is pressed, so no blur/change ever fires
        // just from toggling visibility, exactly the "standard" (no
        // side effects) behavior asked for.
        eyeBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
        eyeBtn.addEventListener("click", () => {
          revealed = !revealed;
          input.type = revealed ? "text" : "password";
          eyeBtn.innerHTML = svgIcon(revealed ? "eye" : "eyeOff");
          eyeBtn.setAttribute("aria-label", revealed ? "Hide password" : "Show password");
        });
        row.appendChild(eyeBtn);
      }
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
    // Lays these two out as a full-width row each (paired against
    // Username/Password's own two half-width rows below them) - see
    // .dc-fields-mqtt in dashboard.css, and ensureDiagGroup()'s own
    // comment for why only the "MQTT" group's fields container is a
    // grid at all. Stripped labels ("Broker"/"Topic Prefix"), not the
    // full "MQTT Broker"/"MQTT Topic Prefix" - same displayName()-
    // stripping bug as the Password check above, confirmed 2026-08-16:
    // this never matched either, so Broker/Topic Prefix never got their
    // full-width span and the whole grid likely rendered as an
    // unintended 2-column jumble instead of the designed layout.
    if (entity.groupName === "MQTT" && (label === "Broker" || label === "Topic Prefix")) {
      entity.el.classList.add("dc-field-span-2");
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
    // "Reboot Device"/"Forget Wi-Fi" - device-level action buttons, moved
    // from the Devices page to the "System" (Diagnostics) page, 2026-08-
    // 15: neither is about any one row in the Devices table, and once the
    // Devices page stopped having anything else on it, keeping them there
    // just because entity_category: config says "not read-only" no longer
    // made sense. Left as entity_category: config in water-collector.yaml
    // (still correct for Home Assistant's own categorization - these
    // really are actions, not diagnostic data) - this is purely a
    // dashboard-local placement override, same pattern as the Debug Log
    // switch just above.
    if (entity.domain === "button" && (entity.name === "Reboot Device" || entity.name === "Forget Wi-Fi")) {
      upsertDiagButton(entity);
      return;
    }
    // MQTT's settings (Enabled/Connect/Broker/Username/Password/Topic
    // Prefix) - this isn't about any one device row, it belongs with the
    // rest of the "System" info/actions, not the Devices table. "MQTT
    // Enabled"/"MQTT Connect" (both switch domain) and "MQTT Status"
    // (text_sensor) get their own bespoke header row (ensureMqttHeader()/
    // updateMqttEnableButton()/updateMqttConnectButton()/
    // updateMqttStatusText() above) instead of the generic upsertService*()/
    // upsertDiagRow() paths every other group's fields use - 2026-08-16
    // redesign, direct feedback, see ensureMqttHeader()'s own comment for
    // the full layout spec. Distinguished by name, not just domain, since
    // both switches share the "switch" domain. The text fields (Broker/
    // Username/Password/Topic Prefix) still go through the normal
    // upsertServiceText() field builder, just pointed at ensureDiagGroup
    // instead of its Devices-page default (ensureServiceGroup), into that
    // group's own .dc-fields area.
    if (entity.groupName === "MQTT") {
      const group = ensureDiagGroup(entity.groupName);
      ensureMqttHeader(group);
      ensureMqttSaveButton(group);
      if (entity.domain === "switch" && entity.name === "MQTT Enabled") updateMqttEnableButton(entity, group);
      else if (entity.domain === "switch") updateMqttConnectButton(entity, group); // "MQTT Connect"
      else if (entity.domain === "text") upsertServiceText(entity, ensureDiagGroup);
      else updateMqttStatusText(entity, group); // the "MQTT Status" text_sensor
      updateMqttStatusIcon();
      updateMqttFieldsVisibility();
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

  // Header MQTT status icon, next to the Wi-Fi one - direct feedback,
  // 2026-08-15: "Mqtt státusz jelző ikon kéne a wifi mellé (ha enabled
  // akkor van ikon, ha connected lesz akkor kikékül, ha disconnected
  // akkor szürke)" (there should be an MQTT status icon next to Wi-Fi -
  // if enabled, the icon shows; once connected it turns blue; if
  // disconnected, grey). Reads "MQTT Enabled"/"MQTT Status" straight out
  // of `entities` rather than being pushed a value directly - simpler
  // than threading two more parameters through render()'s dispatch for
  // something that only needs to run on the rare MQTT-entity update, not
  // on every render.
  // Looks up an MQTT-group entity by its full, real (compile-time) name
  // ("MQTT Enabled", "MQTT Status", ...) - deliberately e.name, NOT
  // displayName(e), confirmed a real bug 2026-08-16: displayName() strips
  // the group name as a leading-word prefix off an entity's name, and
  // every entity in this group already starts with "MQTT " because the
  // group itself is named "MQTT" - so displayName(e) here was always
  // "Enabled"/"Status"/etc, and every call site below (passing the full
  // name, matching how this function's own callers read) never found
  // anything. See upsertServiceSwitch()'s own "Enabled" check for the
  // fuller writeup of the same root cause and its visible fallout.
  function mqttEntity(label) {
    for (const e of entities.values()) {
      if (e.groupName === "MQTT" && e.name === label) return e;
    }
    return null;
  }
  function updateMqttStatusIcon() {
    const wrap = document.getElementById("dc-mqtt-status");
    if (!wrap) return;
    const enabledEntity = mqttEntity("MQTT Enabled");
    const enabled = !!enabledEntity && enabledEntity.value === true;
    wrap.hidden = !enabled;
    if (!enabled) return;
    const statusEntity = mqttEntity("MQTT Status");
    const status = (statusEntity && statusEntity.value) || "";
    wrap.classList.toggle("dc-mqtt-connected", status === "Connected");
    wrap.title = `MQTT: ${status || "unknown"}`;
  }

  // Shows/hides the settings card based on the "MQTT Settings" button's
  // own client-side toggle state (mqttSettingsOpen, ensureMqttHeader()
  // above) - 2026-08-16 redesign, deliberately independent of "MQTT
  // Enabled" now (see .dc-mqtt-collapsed's own history in dashboard.css
  // for why that used to be the gate, and stopped being one). See
  // .dc-mqtt-collapsed in dashboard.css for the actual hide/show rule
  // this toggles.
  function updateMqttFieldsVisibility() {
    const group = diagGroups.get("MQTT");
    if (!group) return;
    group.fields.classList.toggle("dc-mqtt-collapsed", !mqttSettingsOpen);
    if (group.mqttSettingsBtn) {
      group.mqttSettingsBtn.classList.toggle("dc-btn-active", mqttSettingsOpen);
    }
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
              <svg viewBox="0 0 24 22" aria-hidden="true">
                <path class="arc arc-3" d="M3 8.5a15 15 0 0 1 18 0"/>
                <path class="arc arc-2" d="M6.3 12a10.5 10.5 0 0 1 11.4 0"/>
                <path class="arc arc-1" d="M9.5 15.5a6 6 0 0 1 5 0"/>
                <circle class="dot" cx="12" cy="18.5" r="1.4"/>
              </svg>
            </div>
            <div id="dc-mqtt-status" hidden title="MQTT">${svgIcon("mqttNode")}</div>
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

  // On an abrupt device reboot (crash, power cycle, Reboot Device button -
  // any path that isn't a clean TCP close) the browser's existing socket gets
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
