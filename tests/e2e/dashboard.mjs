// End-to-end tests for web/dashboard.js, driven through a real browser.
//
// These cover the behaviours that only exist once the whole file is
// running together - the ones that broke repeatedly and that no amount of
// reading the code caught: what Update actually sends, whether a second
// client can change the value in between, and whether a displayed reading
// is the value the device reported or a float32's nearest approximation
// of it. The device side of the same contract is covered by
// tests/cpp/test_firmware.cpp.
//
// Run: node tests/e2e/dashboard.mjs
// Needs Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH, or
// `npx playwright install chromium`).

import { mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

// Playwright is just as likely to be installed globally as in this repo,
// and NODE_PATH doesn't apply to ESM imports - so fall back to resolving
// it out of the global module root by path.
async function loadChromium() {
  // Playwright ships as CommonJS, so an ESM import of it may land the
  // exports under .default depending on how it was resolved.
  const pick = (mod) => mod.chromium || (mod.default && mod.default.chromium);
  try {
    return pick(await import("playwright"));
  } catch (error) {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return pick(await import(pathToFileURL(join(root, "playwright", "index.js")).href));
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

let checks = 0;
let failures = 0;

function check(condition, label) {
  checks++;
  if (!condition) {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}

function eq(actual, expected, label) {
  checks++;
  if (actual !== expected) {
    failures++;
    console.log(`  FAIL ${label}\n       got:      ${JSON.stringify(actual)}\n       expected: ${JSON.stringify(expected)}`);
  }
}

// --- the state a real device sends ---------------------------------------

const PULSE = "Pulse Meter 1";
const FLOW = "Modbus Device 1";

function pulseMeterEntities() {
  return [
    { id: "switch/Pulse Meter 1 Registered", domain: "switch", name: "Pulse Meter 1 Registered", sorting_group: PULSE, sorting_weight: 90, value: true, entity_category: 1 },
    { id: "text/Pulse Meter 1 Display Name", domain: "text", name: "Pulse Meter 1 Display Name", sorting_group: PULSE, sorting_weight: 6, value: "Fő vízóra", entity_category: 1 },
    { id: "sensor/Pulse Meter 1 Total Consumption", domain: "sensor", name: "Pulse Meter 1 Total Consumption", sorting_group: PULSE, sorting_weight: 10, value: 12345.001, uom: "m³", state: "12345.001 m³" },
    { id: "sensor/Pulse Meter 1 Calculated Flow Rate", domain: "sensor", name: "Pulse Meter 1 Calculated Flow Rate", sorting_group: PULSE, sorting_weight: 20, value: 2.5, uom: "L/min", state: "2.500 L/min" },
    // ESPHome rewrites "/" inside an entity NAME to U+2044 FRACTION SLASH
    // (its REST/SSE paths are built from names) but leaves the unit's own
    // slash alone - so the name below is exactly what a device sends.
    { id: "sensor/Pulse Meter 1 Calculated Flow Rate (m³\u2044h)", domain: "sensor", name: "Pulse Meter 1 Calculated Flow Rate (m³\u2044h)", sorting_group: PULSE, sorting_weight: 21, value: 0.15, uom: "m³/h", state: "0.15000 m³/h" },
    { id: "number/Pulse Meter 1 Reading", domain: "number", name: "Pulse Meter 1 Reading", sorting_group: PULSE, sorting_weight: 60, value: 0, min_value: 0, max_value: 1000000, step: 0.001, uom: "m³", entity_category: 1 },
    { id: "text/Pulse Meter 1 Update", domain: "text", name: "Pulse Meter 1 Update", sorting_group: PULSE, sorting_weight: 80, value: "", max_length: 24, entity_category: 1 },
    { id: "number/Pulse Meter 1 Zero-Flow Timeout", domain: "number", name: "Pulse Meter 1 Zero-Flow Timeout", sorting_group: PULSE, sorting_weight: 70, value: 60, min_value: 10, max_value: 600, step: 1, entity_category: 1 },
    { id: "button/Pulse Meter 1 Delete", domain: "button", name: "Pulse Meter 1 Delete", sorting_group: PULSE, sorting_weight: 95, entity_category: 1 },
    // Published last, exactly as volume::publish_volume() does.
    { id: "text_sensor/Pulse Meter 1 Exact Millilitres", domain: "text_sensor", name: "Pulse Meter 1 Exact Millilitres", sorting_group: PULSE, sorting_weight: 55, value: "12345001000|12344992000", entity_category: 2 },
  ];
}

function flowSlotEntities() {
  return [
    { id: "select/Modbus Device 1 Device Type", domain: "select", name: "Modbus Device 1 Device Type", sorting_group: FLOW, sorting_weight: 5, value: "Flow", entity_category: 1 },
    { id: "text/Modbus Device 1 Address Change Request", domain: "text", name: "Modbus Device 1 Address Change Request", sorting_group: FLOW, sorting_weight: 19, value: "", max_length: 40, entity_category: 1 },
    { id: "number/Modbus Device 1 Modbus Address", domain: "number", name: "Modbus Device 1 Modbus Address", sorting_group: FLOW, sorting_weight: 20, value: 1, min_value: 0, max_value: 247, step: 1, entity_category: 1 },
    { id: "number/Modbus Device 1 Sort Order", domain: "number", name: "Modbus Device 1 Sort Order", sorting_group: FLOW, sorting_weight: 25, value: 1, entity_category: 2 },
    { id: "binary_sensor/Modbus Device 1 Online", domain: "binary_sensor", name: "Modbus Device 1 Online", sorting_group: FLOW, sorting_weight: 15, value: true, entity_category: 2 },
    { id: "text/Modbus Device 1 Display Name", domain: "text", name: "Modbus Device 1 Display Name", sorting_group: FLOW, sorting_weight: 30, value: "Kerti óra", entity_category: 1 },
    { id: "number/Modbus Device 1 Reading", domain: "number", name: "Modbus Device 1 Reading", sorting_group: FLOW, sorting_weight: 26, value: 0, min_value: 0, max_value: 1000000, step: 0.000001, uom: "m³", entity_category: 1 },
    { id: "text/Modbus Device 1 Update", domain: "text", name: "Modbus Device 1 Update", sorting_group: FLOW, sorting_weight: 90, value: "", max_length: 24, entity_category: 1 },
    { id: "button/Modbus Device 1 Delete", domain: "button", name: "Modbus Device 1 Delete", sorting_group: FLOW, sorting_weight: 100, entity_category: 1 },
    { id: "button/Modbus Device 1 Reset Correction", domain: "button", name: "Modbus Device 1 Reset Correction", sorting_group: FLOW, sorting_weight: 91, entity_category: 1 },
    { id: "sensor/Modbus Device 1 Flow Rate", domain: "sensor", name: "Modbus Device 1 Flow Rate", sorting_group: FLOW, sorting_weight: 11, value: 0.12345, uom: "m³/h", state: "0.123450 m³/h" },
    { id: "sensor/Modbus Device 1 Flow Rate (L\u2044min)", domain: "sensor", name: "Modbus Device 1 Flow Rate (L\u2044min)", sorting_group: FLOW, sorting_weight: 12, value: 2.0575, uom: "L/min", state: "2.05750 L/min" },
    // 12345.123456 m3. The float32 nearest to it is 12345.1230468750, so
    // the server's own state string (built from that float) is already
    // wrong in the third decimal - which is exactly the case the exact
    // channel exists for.
    { id: "sensor/Modbus Device 1 Total Consumption", domain: "sensor", name: "Modbus Device 1 Total Consumption", sorting_group: FLOW, sorting_weight: 10, value: 12345.123046875, uom: "m³", state: "12345.123047 m³" },
    { id: "sensor/Modbus Device 1 Correction Offset", domain: "sensor", name: "Modbus Device 1 Correction Offset", sorting_group: FLOW, sorting_weight: 27, value: 0.062691, uom: "m³", state: "0.062691 m³" },
    { id: "sensor/Modbus Device 1 Battery Voltage", domain: "sensor", name: "Modbus Device 1 Battery Voltage", sorting_group: FLOW, sorting_weight: 30, value: 3.58, uom: "V", state: "3.58 V" },
    { id: "button/Modbus Device 1 Refresh Device Info", domain: "button", name: "Modbus Device 1 Refresh Device Info", sorting_group: FLOW, sorting_weight: 92, entity_category: 1 },
    { id: "text_sensor/Modbus Device 1 Exact Millilitres", domain: "text_sensor", name: "Modbus Device 1 Exact Millilitres", sorting_group: FLOW, sorting_weight: 28, value: "12345123456|62691", entity_category: 2 },
  ];
}

async function bootstrap(page) {
  await page.evaluate(() => {
    window.__emit("sorting_group", { name: "Pulse Meters", sorting_weight: 8 });
    window.__emit("sorting_group", { name: "Pulse Meter 1", sorting_weight: 10 });
    window.__emit("sorting_group", { name: "Modbus Devices", sorting_weight: 30 });
    window.__emit("sorting_group", { name: "Modbus Device 1", sorting_weight: 31 });
    window.__emit("sorting_group", { name: "System", sorting_weight: 90 });
  });
  await page.evaluate(
    ([pulse, flow]) => {
      for (const e of pulse) window.__emit("state", e);
      for (const e of flow) window.__emit("state", e);
      window.__emit("state", {
        id: "text_sensor/Device Update Result",
        domain: "text_sensor",
        name: "Device Update Result",
        sorting_group: "System",
        sorting_weight: 70,
        value: "",
        entity_category: 2,
      });
    },
    [pulseMeterEntities(), flowSlotEntities()]
  );
  // Past the initial-burst settle (SETTLE_QUIET_MS in web/dashboard.js),
  // so the tests run against a dashboard in the state a device actually
  // leaves it in - renamed group labels, for one, are only applied once
  // the burst has gone quiet.
  await page.waitForTimeout(1000);
  // Real clicks only work on a visible element, and the dashboard shows
  // one page at a time - the Devices table lives on the "service" page.
  await page.evaluate(() => document.querySelector('.hub-nav-item[data-page="service"]').click());
  await page.waitForTimeout(100);
}


// --- real user interaction -------------------------------------------------
// The tests above drive the Update button with an in-page .click(), which
// skips the part of the browser that actually broke: focusing a field,
// typing into it, and then clicking elsewhere fires `change` on the input
// BEFORE the button's own click handler runs. Anything the change handler
// does to the field is therefore already done by the time Update reads it.
// These tests use real Playwright input so that ordering is real.

async function openRow(page, displayName) {
  // A row can only be opened from the Devices page, and a real click only
  // works on a visible element - so make sure we are on it, rather than
  // depending on whichever page the previous test happened to leave open.
  await page.evaluate(() => document.querySelector('.hub-nav-item[data-page="service"]').click());
  await page.waitForTimeout(60);
  // The pencil is not what is under test - only the Reading field's own
  // typing/blur/click sequence is - so opening the row stays a plain
  // in-page click.
  await page.evaluate((label) => {
    const inputs = [...document.querySelectorAll("td.hub-pressure-name input")];
    const target = inputs.find((i) => i.value === label);
    if (!target) throw new Error(`no device row named ${label}`);
    target.closest("tr").querySelector(".hub-pressure-edit-btn").click();
  }, displayName);
  const expanded = page.locator("tr.hub-pulsemeter-expanded");
  return {
    name: page.locator("tr.hub-pressure-row-editing td.hub-pressure-name input"),
    reading: expanded.locator("input.hub-reading-input"),
    update: expanded.locator('button:text-is("Update")'),
    zft: expanded.locator("input.hub-zft-input"),
    addr: expanded.locator("input.hub-addr-input"),
    save: page.locator("tr.hub-pressure-row-editing .hub-pressure-save-btn"),
    close: async () => {
      await page.evaluate(() => {
        const row = document.querySelector("tr.hub-pressure-row-editing");
        if (row) row.querySelector(".hub-pressure-cancel-btn").click();
      });
    },
  };
}

async function resetHarness(page) {
  await page.evaluate(() => {
    window.__posts.length = 0;
    window.__alerts.length = 0;
    window.__confirms.length = 0;
    window.__confirmAnswer = true;
  });
}

// Triple-click selects the field's contents, then real keystrokes replace
// them - so `input` fires per character and `change` fires on blur, i.e.
// when the Update button is clicked. Deliberately not fill(), which sets
// the value in one go and fires `change` immediately, hiding the very
// ordering these tests exist to pin down.
async function typeReading(row, text) {
  await row.reading.click({ clickCount: 3 });
  await row.reading.pressSequentially(text, { delay: 5 });
}

async function harness(page) {
  return page.evaluate(() => ({
    posts: window.__posts.slice(),
    alerts: window.__alerts.slice(),
    confirms: window.__confirms.slice(),
  }));
}

async function testTypedDraftSurvivesBlur(page) {
  console.log("typing: a rejected value is not replaced by the live reading");
  const row = await openRow(page, "Fő vízóra");
  await resetHarness(page);
  await typeReading(row, "12abc");
  // A REAL click: this blurs the input first, so `change` fires before the
  // button's handler. That is what silently rewrote the field to the live
  // total (0 on a fresh meter) and made Update ask to apply 0.
  await row.update.click();
  const state = await harness(page);
  eq(await row.reading.inputValue(), "12abc", "the typed draft is still there to be corrected");
  eq(state.posts.length, 0, "nothing was sent");
  eq(state.confirms.length, 0, "and nothing was offered for confirmation");
  eq(state.alerts.length, 1, "the refusal was explained");
  await row.close();
}

async function testOutOfRangeDraftSurvivesBlur(page) {
  console.log("typing: an out-of-range value is not replaced either");
  const row = await openRow(page, "Fő vízóra");
  await resetHarness(page);
  await typeReading(row, "2000000");
  await row.update.click();
  const state = await harness(page);
  eq(await row.reading.inputValue(), "2000000", "the out-of-range draft stays");
  eq(state.posts.length, 0, "nothing was sent");
  eq(state.confirms.length, 0, "nothing was confirmed");
  check(
    state.alerts[0] && state.alerts[0].includes("1000000"),
    `the message names this meter's own range (got "${state.alerts[0]}")`
  );
  await row.close();
}

async function testReadingCanAlwaysExpressTheCurrentTotal(page) {
  console.log("typing: a reading past the old 100000 ceiling is accepted");
  // A meter whose total has climbed past six figures must still be
  // correctable. A ceiling below the meter's own max would leave this
  // field unable to express the very value it exists to correct -
  // correction possible only downwards, to a wrong number.
  const row = await openRow(page, "Fő vízóra");
  await resetHarness(page);
  await typeReading(row, "100000.001");
  const clicked = row.update.click();
  await page.waitForTimeout(60);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "20|Pulse Meter 1|ok|100000.001" })
  );
  await clicked;
  await page.waitForTimeout(60);
  const state = await harness(page);
  eq(state.alerts.length, 0, `no complaint about the range (got ${JSON.stringify(state.alerts)})`);
  eq(state.posts.length, 1, "and the correction is sent");
  await row.close();
}

async function testCorrectionAfterRejectionSendsTheNewValue(page) {
  console.log("typing: after a rejected attempt, the corrected value is what gets sent");
  const row = await openRow(page, "Fő vízóra");
  await resetHarness(page);
  await typeReading(row, "12abc");
  await row.update.click();
  await typeReading(row, "1234.567");
  const clicked = row.update.click();
  await page.waitForTimeout(60);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "10|Pulse Meter 1|ok|1234.567" })
  );
  await clicked;
  await page.waitForTimeout(60);
  const state = await harness(page);
  eq(state.posts.length, 1, `exactly one request (got ${JSON.stringify(state.posts)})`);
  check(
    state.posts[0] && state.posts[0].path.endsWith("value=1234.567"),
    `it carries the corrected value, not the rejected one or a live 0 (got "${state.posts[0] && state.posts[0].path}")`
  );
  check(
    state.confirms[0] && state.confirms[0].includes("1234.567"),
    `and the confirmation named that same value (got "${state.confirms[0]}")`
  );
  await row.close();
}

// Zero-Flow Timeout is a draft, same as Reading's own field - it only
// ever reaches the device when the row's own Save checkmark is
// actually clicked, never on blur, and never with a confirm() popup
// either.
// Opening a DIFFERENT row's editor force-cancels whichever one was open
// (deviceEditingRow._cancelEdit(), same as the row's own X) - but that
// must mean an untyped Reading draft is actually gone, not merely
// hidden: reopening the first row later must show its live value, never
// what was typed and abandoned. No POST either way - this is purely
// about what the field DISPLAYS on return, not what was sent.
async function testSwitchingRowsDiscardsAnUnsavedReadingDraft(page) {
  console.log("switching to another row's editor discards an unsaved Reading draft, same as pressing X");
  const rowA = await openRow(page, "Fő vízóra");
  await resetHarness(page);
  const liveBefore = await rowA.reading.inputValue();
  await typeReading(rowA, "999.111");
  eq(await rowA.reading.inputValue(), "999.111", "the draft is visible while still on this row");
  // Switch away via the OTHER row's own pencil, not this row's Cancel.
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("td.hub-pressure-name input")];
    const target = inputs.find((i) => i.value === "Kerti óra");
    target.closest("tr").querySelector(".hub-pressure-edit-btn").click();
  });
  await page.waitForTimeout(60);
  const state = await harness(page);
  // Not a blanket zero - opening the OTHER row (Kerti óra, a Modbus
  // slot) legitimately fires its own on-demand device-info refresh, an
  // existing and unrelated side effect of that row's own enterEdit().
  // What must never happen is anything reaching THIS row's own group -
  // its technical entity path (Pulse Meter 1), not its custom display
  // name, which plays no part in how a request is addressed.
  check(
    !state.posts.some((p) => p.path.includes("Pulse%20Meter%201")),
    `switching rows sends nothing for the abandoned draft (got ${JSON.stringify(state.posts)})`
  );
  // Back to the first row.
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("td.hub-pressure-name input")];
    const target = inputs.find((i) => i.value === "Fő vízóra");
    target.closest("tr").querySelector(".hub-pressure-edit-btn").click();
  });
  await page.waitForTimeout(60);
  eq(
    await rowA.reading.inputValue(),
    liveBefore,
    "reopening the row shows the live reading again, not the abandoned draft"
  );
  await rowA.close();
}

// Reading used to commit ONLY through its own Update button - Save
// (Name + Zero-Flow Timeout) never touched it, so a person who edited
// Reading and pressed the row's own checkmark saw nothing happen at
// all. Save now runs the exact same applyTypedReading() Update itself
// uses - same validation, same "this
// overwrites the accumulated total" confirmation - whenever Reading was
// actually typed into, and a decline there cancels the whole Save, not
// just the reading half of it.
async function testSaveAppliesADirtyReadingWithItsOwnConfirmation(page) {
  console.log("Save also applies a typed Reading, through the same confirmation Update itself uses");
  const row = await openRow(page, "Fő vízóra");
  await resetHarness(page);

  // Declined: nothing is sent at all, not even the unrelated Name field.
  await page.evaluate(() => {
    window.__confirmAnswer = false;
  });
  await typeReading(row, "1234.567");
  await row.save.click();
  await page.waitForTimeout(60);
  let state = await harness(page);
  eq(state.confirms.length, 1, "the same confirmation Update itself shows is asked here too");
  check(
    state.confirms[0] && state.confirms[0].includes("1234.567"),
    `it names the typed value (got "${state.confirms[0]}")`
  );
  eq(state.posts.length, 0, "declining sends nothing at all, not even Name");
  eq(await row.reading.inputValue(), "1234.567", "the reading draft is still there to reconsider");

  // Confirmed: Reading (through Update's own channel) and Name both go
  // out from the one Save press.
  await resetHarness(page);
  await page.evaluate(() => {
    window.__confirmAnswer = true;
  });
  const clicked = row.save.click();
  await page.waitForTimeout(60);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "30|Pulse Meter 1|ok|1234.567" })
  );
  await clicked;
  await page.waitForTimeout(60);
  state = await harness(page);
  check(
    state.posts.some((p) => p.path.includes("Update/set?value=1234.567")),
    `Reading is applied through its own Update channel (got ${JSON.stringify(state.posts)})`
  );
  check(
    state.posts.some((p) => p.path.includes("Display%20Name/set")),
    `Name is sent in the same Save press (got ${JSON.stringify(state.posts)})`
  );
}

// "A pipa csak akkor legyen enabled, ha van mit postolni. Amíg nem
// módosítok (vagy visszaírom eredetire), akkor a pipa beszürkül
// (disabled lesz)."
async function testSaveIsDisabledUntilSomethingActuallyChanged(page) {
  console.log("Save stays disabled until Name, Zero-Flow Timeout, or Reading actually differs from its live value");
  const row = await openRow(page, "Fő vízóra");
  check(await row.save.isDisabled(), "nothing typed yet - Save starts disabled");

  const origName = await row.name.inputValue();
  await row.name.fill(origName + " x");
  check(!(await row.save.isDisabled()), "a changed Name enables Save");
  await row.name.fill(origName);
  check(await row.save.isDisabled(), "typing the exact original Name back disables Save again");

  const origZft = await row.zft.inputValue();
  await row.zft.fill(String(Number(origZft) + 1));
  check(!(await row.save.isDisabled()), "a changed Zero-Flow Timeout enables Save");
  await row.zft.fill(origZft);
  check(await row.save.isDisabled(), "typing the exact original Zero-Flow Timeout back disables Save again");

  await typeReading(row, "42");
  check(!(await row.save.isDisabled()), "typing into Reading enables Save");
  await row.close();
}

// Same feature, same reasoning, now for a Modbus (pressure/flow) row -
// its own Save used to only ever touch Name and Modbus Address, so
// typing into Reading and pressing the checkmark did nothing, same gap
// the pulse meter row had. "Kerti óra" is the registered Flow-type slot
// (Modbus Device 1) - a Pressure-type slot's Reading field is hidden and
// so can never become dirty in the first place. Address is left
// untouched here (still its live value, 1) so this exercises only the
// Reading half - reprogramming has its own dedicated tests below via
// startAddressChange().
async function testPressureSaveAppliesADirtyReadingWithItsOwnConfirmation(page) {
  console.log("pressure/flow row: Save also applies a typed Reading, through the same confirmation Update itself uses");
  const row = await openRow(page, "Kerti óra");
  // The address-change tests above (startAddressChange) leave this row's
  // Address field showing whatever they last typed there, and - same as
  // on a real page until the device's own next state push arrives -
  // nothing here resyncs it to the live entity meanwhile, so a leftover
  // mismatch between the two is still sitting there. Pin the live entity
  // to match what the field already shows, so Save sees an address that
  // genuinely did not change, and this test stays about the Reading
  // edit only, not an incidental reprogram left over from another test.
  const currentAddr = await row.addr.inputValue();
  await page.evaluate(
    (v) => window.__emit("state", { id: "number/Modbus Device 1 Modbus Address", value: Number(v) }),
    currentAddr
  );
  await resetHarness(page);

  // Declined: nothing is sent at all, not even the unrelated Name field.
  await page.evaluate(() => {
    window.__confirmAnswer = false;
  });
  await typeReading(row, "77.5");
  await row.save.click();
  await page.waitForTimeout(60);
  let state = await harness(page);
  eq(state.confirms.length, 1, "the same confirmation Update itself shows is asked here too");
  check(
    state.confirms[0] && state.confirms[0].includes("77.5"),
    `it names the typed value (got "${state.confirms[0]}")`
  );
  eq(state.posts.length, 0, "declining sends nothing at all, not even Name");
  eq(await row.reading.inputValue(), "77.5", "the reading draft is still there to reconsider");

  // Confirmed: Reading (through Update's own channel) and Name both go
  // out from the one Save press. Address is unchanged (still 1), so this
  // is not a reprogramming - no separate address-change result to emit.
  await resetHarness(page);
  await page.evaluate(() => {
    window.__confirmAnswer = true;
  });
  const clicked = row.save.click();
  await page.waitForTimeout(60);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "40|Modbus Device 1|ok|77.5" })
  );
  await clicked;
  await page.waitForTimeout(60);
  state = await harness(page);
  check(
    state.posts.some((p) => p.path.includes("Update/set?value=77.5")),
    `Reading is applied through its own Update channel (got ${JSON.stringify(state.posts)})`
  );
  check(
    state.posts.some((p) => p.path.includes("Display%20Name/set")),
    `Name is sent in the same Save press (got ${JSON.stringify(state.posts)})`
  );
  // ...and no address-change machinery fired for an address that never
  // moved.
  check(
    !state.posts.some((p) => p.path.includes("Address%20Change%20Request")),
    `an unchanged address never arms the reprogramming interlock (got ${JSON.stringify(state.posts)})`
  );
}

// "A pipa csak akkor legyen enabled, ha van mit postolni" - same rule,
// now covering all three of this row's own dirty-trackable fields: Name,
// Modbus Address, and (Flow-type only) Reading.
async function testPressureSaveIsDisabledUntilSomethingActuallyChanged(page) {
  console.log("pressure/flow row: Save stays disabled until Name, Address, or Reading actually differs from its live value");
  const row = await openRow(page, "Kerti óra");
  check(await row.save.isDisabled(), "nothing typed yet - Save starts disabled");

  const origName = await row.name.inputValue();
  await row.name.fill(origName + " x");
  check(!(await row.save.isDisabled()), "a changed Name enables Save");
  await row.name.fill(origName);
  check(await row.save.isDisabled(), "typing the exact original Name back disables Save again");

  const origAddr = await row.addr.inputValue();
  await row.addr.fill(String(Number(origAddr) + 1));
  check(!(await row.save.isDisabled()), "a changed Modbus Address enables Save");
  await row.addr.fill(origAddr);
  check(await row.save.isDisabled(), "typing the exact original Modbus Address back disables Save again");

  await typeReading(row, "42");
  check(!(await row.save.isDisabled()), "typing into Reading enables Save");
  await row.close();
}

// A declined Reading confirmation must cancel the WHOLE Save, not just
// the reading half of it - a "no" to one question (overwrite the
// accumulated total) must not quietly go on to carry out the other,
// higher-consequence one (reprogram the physical device's bus address).
// This also pins down the timing reorder itself: if the address-change's
// own watchUpdateResult() were armed before the reading confirmation is
// answered, this test's declined confirm() would still leave that arm
// sitting there unconsumed - harmless in itself, but the address POSTs
// below must never have fired at all, confirmed directly.
async function testDeclinedReadingConfirmationCancelsAddressChangeToo(page) {
  console.log("pressure/flow row: declining the Reading confirmation cancels the address change too, not just Reading");
  const row = await openRow(page, "Kerti óra");
  await resetHarness(page);
  await page.evaluate(() => {
    window.__confirmAnswer = false;
  });
  await row.addr.fill("7");
  await typeReading(row, "88.25");
  await row.save.click();
  await page.waitForTimeout(60);
  const state = await harness(page);
  eq(state.confirms.length, 1, "only the reading confirmation is asked - nothing about the address change");
  eq(state.posts.length, 0, "nothing is sent at all - not the address arm, not the address, not Name");
  eq(await row.addr.inputValue(), "7", "the address edit is still there to reconsider, same as Reading");
  await row.close();
}

async function testZeroFlowTimeoutOnlyAppliesOnSave(page) {
  console.log("Zero-Flow Timeout is a draft until Save is pressed, not applied on lostfocus");
  const row = await openRow(page, "Fő vízóra");
  await resetHarness(page);

  // Typing and blurring alone - leaving the field, or opening it and
  // walking away - must send nothing and ask nothing.
  await row.zft.fill("120");
  await row.zft.blur();
  await page.waitForTimeout(60);
  let state = await harness(page);
  eq(state.confirms.length, 0, "no dialog is shown for this field");
  eq(state.posts.length, 0, "blurring the field alone sends nothing to the device");
  eq(await row.zft.inputValue(), "120", "the typed draft is still there, not reverted");

  // Save commits it - batched with Name, same one press.
  await row.save.click();
  await page.waitForTimeout(60);
  state = await harness(page);
  eq(state.confirms.length, 0, "still no dialog");
  check(
    state.posts.some((p) => p.path.includes("Zero-Flow%20Timeout/set?value=120")),
    `Save sends the typed value (got ${JSON.stringify(state.posts)})`
  );
  check(
    state.posts.some((p) => p.path.includes("Display%20Name/set")),
    `Save also sends Name, in the same press (got ${JSON.stringify(state.posts)})`
  );
}

// An invalid draft must not go anywhere near the device, and must not be
// silently thrown away either - same treatment Reading's own out-of-
// range value gets, not the old blur-time silent revert.
async function testZeroFlowTimeoutRejectsOutOfRangeOnSave(page) {
  console.log("Zero-Flow Timeout refuses an out-of-range draft at Save, and keeps it visible to fix");
  const row = await openRow(page, "Fő vízóra");
  await resetHarness(page);
  await row.zft.fill("50000");
  await row.zft.blur();
  await row.save.click();
  await page.waitForTimeout(60);
  const state = await harness(page);
  eq(state.posts.length, 0, "an out-of-range draft is never sent");
  check(state.alerts.length === 1, `the person is told why (got ${JSON.stringify(state.alerts)})`);
  eq(await row.zft.inputValue(), "50000", "the draft stays visible to correct, not reverted");
  await row.close();
}

async function testResolutionMessageIsPerMeter(page) {
  console.log("typing: the resolution message comes from the meter's own step");
  const pulse = await openRow(page, "Fő vízóra");
  await resetHarness(page);
  await typeReading(pulse, "0.000001");
  await pulse.update.click();
  let state = await harness(page);
  eq(state.posts.length, 0, "a sub-litre reading is not sent to a litre-counting meter");
  check(
    state.alerts[0] && state.alerts[0].includes("0.001") && !state.alerts[0].includes("0.000001 m"),
    `the message states 0.001 m³, this meter's own resolution (got "${state.alerts[0]}")`
  );
  await pulse.close();

  const flow = await openRow(page, "Kerti óra");
  await resetHarness(page);
  await typeReading(flow, "0.000001");
  const clicked = flow.update.click();
  await page.waitForTimeout(60);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "11|Modbus Device 1|ok|0.000001" })
  );
  await clicked;
  await page.waitForTimeout(60);
  state = await harness(page);
  eq(state.alerts.length, 0, `the same value is fine on a millilitre meter (got ${JSON.stringify(state.alerts)})`);
  eq(state.posts.length, 1, "and it is sent");
  await flow.close();
}

async function testNoOldValueFlashDuringUpdate(page) {
  console.log("typing: the old reading never flashes back during a successful update");
  const row = await openRow(page, "Fő vízóra");
  await resetHarness(page);
  await typeReading(row, "777.123");
  const clicked = row.update.click();
  await page.waitForTimeout(60);
  eq(await row.reading.inputValue(), "777.123", "still the typed value once the request is out");

  // The device publishes in this order: numeric total, exact millilitres,
  // then the result. The window between the first two is the dangerous
  // one - the numeric total has moved but the exact channel the dashboard
  // renders from has not, so a render there produces the OLD number.
  await page.evaluate(() =>
    window.__emit("state", { id: "sensor/Pulse Meter 1 Total Consumption", value: 777.123, state: "777.123 m³" })
  );
  await page.waitForTimeout(80);
  eq(await row.reading.inputValue(), "777.123", "no flash while the exact channel is still behind");

  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Pulse Meter 1 Exact Millilitres", value: "777123000|777114000" })
  );
  await page.waitForTimeout(80);
  eq(await row.reading.inputValue(), "777.123", "no flash once it catches up either");

  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "12|Pulse Meter 1|ok|777.123" })
  );
  await clicked;
  await page.waitForTimeout(80);
  eq(await row.reading.inputValue(), "777.123", "and the committed value is what stands afterwards");
  const state = await harness(page);
  eq(state.alerts.length, 0, `no complaint on a clean update (got ${JSON.stringify(state.alerts)})`);
  await row.close();
}

async function testRefusalRestoresLiveValue(page) {
  console.log("typing: a device refusal puts the real reading back");
  await page.evaluate(() => {
    window.__emit("state", { id: "sensor/Pulse Meter 1 Total Consumption", value: 777.123, state: "777.123 m³" });
    window.__emit("state", { id: "text_sensor/Pulse Meter 1 Exact Millilitres", value: "777123000|777114000" });
  });
  await page.waitForTimeout(80);
  const row = await openRow(page, "Fő vízóra");
  await resetHarness(page);
  await typeReading(row, "5.5");
  const clicked = row.update.click();
  await page.waitForTimeout(60);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "13|Pulse Meter 1|stale|5.5" })
  );
  await clicked;
  await page.waitForTimeout(80);
  eq(await row.reading.inputValue(), "777.123", "the refused value is gone and the live reading is back");
  const state = await harness(page);
  eq(state.alerts.length, 1, "and the refusal was reported");
  await row.close();
}

async function testAnotherTabsResultIsNotOurs(page) {
  console.log("typing: another client's result cannot resolve our update");
  const row = await openRow(page, "Fő vízóra");
  await resetHarness(page);
  await typeReading(row, "888.001");
  const clicked = row.update.click();
  await page.waitForTimeout(60);
  // A second browser tab updated the SAME meter to something else; its
  // outcome arrives on the shared channel first.
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "14|Pulse Meter 1|stale|4242" })
  );
  await page.waitForTimeout(80);
  let state = await harness(page);
  eq(state.alerts.length, 0, "someone else's refusal is not reported as ours");
  eq(await row.reading.inputValue(), "888.001", "and it does not disturb our pending value");

  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "15|Pulse Meter 1|ok|888.001" })
  );
  await clicked;
  await page.waitForTimeout(80);
  state = await harness(page);
  eq(state.alerts.length, 0, "our own result resolves cleanly");
  eq(await row.reading.inputValue(), "888.001", "with the committed value on screen");
  await row.close();
}


async function testBothFlowRateUnitsOnTheCard(page) {
  console.log("home card: both flow rate units, one label, aligned");
  await page.evaluate(() => document.querySelector('.hub-nav-item[data-page="home"]').click());
  await page.waitForTimeout(150);
  const cards = await page.evaluate(() => {
    const out = {};
    for (const card of document.querySelectorAll("#hub-page-home .hub-meter-card")) {
      const title = card.querySelector(".hub-meter-card-header-label");
      out[title ? title.textContent.trim() : "?"] = [...card.querySelectorAll(".hub-metric")].map((m) => ({
        label: m.querySelector(".label-text").textContent,
        values: [...m.querySelectorAll(".hub-metric-value")].map((v) => ({
          value: v.querySelector(".val").textContent,
          unit: v.querySelector(".unit").textContent,
          left: Math.round(v.getBoundingClientRect().left),
        })),
      }));
    }
    return out;
  });

  const flow = cards["Kerti óra"];
  const pulse = cards["Fő vízóra"];
  check(!!flow && !!pulse, `both meter cards are on the Home page (got ${Object.keys(cards)})`);
  if (!flow || !pulse) return;

  // One row per measurement, not one per unit - the label used to be
  // printed under each of the two values.
  const flowRates = flow.filter((m) => m.label === "Flow Rate");
  const pulseRates = pulse.filter((m) => m.label === "Calculated Flow Rate");
  eq(flowRates.length, 1, "the flow meter's rate is one row, not two");
  eq(pulseRates.length, 1, "and so is the pulse meter's");
  if (!flowRates.length || !pulseRates.length) return;

  // Same order on every meter, whichever unit it measures in natively,
  // and spelled exactly as the entity carries it: "L/min" is the only
  // spelling Home Assistant's volume_flow_rate device class accepts, and
  // showing a different one here would make the dashboard and HA disagree
  // about what the number is measured in.
  eq(flowRates[0].values.map((v) => v.unit).join(" | "), "m³/h | L/min", "flow meter: m³/h left, L/min right");
  eq(pulseRates[0].values.map((v) => v.unit).join(" | "), "m³/h | L/min", "pulse meter: the same way round");

  // Both values are the full-precision ones the device sent.
  eq(flowRates[0].values[0].value, "0.123450", "the flow meter's m³/h reading is shown in full");
  eq(flowRates[0].values[1].value, "2.05750", "and its L/min equivalent alongside");

  // ...and the second column starts at the same x on every card, so the
  // two readings line up down the page instead of drifting with however
  // many digits the first value happens to have.
  eq(
    flowRates[0].values[1].left,
    pulseRates[0].values[1].left,
    "the second value starts at the same place on both cards"
  );

  // The reserved width has to hold the practical maximum, or the column
  // stops lining up exactly when a meter is running hardest.
  await page.evaluate(() => {
    window.__emit("state", {
      id: "sensor/Modbus Device 1 Flow Rate",
      value: 99.999999,
      state: "99.999999 m³/h",
    });
  });
  await page.waitForTimeout(120);
  const stretched = await page.evaluate(() => {
    const card = [...document.querySelectorAll("#hub-page-home .hub-meter-card")].find(
      (c) => c.querySelector(".hub-meter-card-header-label").textContent.trim() === "Kerti óra"
    );
    const row = [...card.querySelectorAll(".hub-metric")].find(
      (m) => m.querySelector(".label-text").textContent === "Flow Rate"
    );
    const cells = [...row.querySelectorAll(".hub-metric-value")];
    return { value: cells[0].querySelector(".val").textContent, left: Math.round(cells[1].getBoundingClientRect().left) };
  });
  eq(stretched.value, "99.999999", "a flat-out flow rate is shown in full");
  eq(stretched.left, flowRates[0].values[1].left, "and does not push the second value out of the column");

  // The two units are separated by a hairline, and they have to stay on
  // one line for it to read as a divider rather than a stray mark at the
  // start of a wrapped row. Checked at 360px - the narrowest phone this
  // dashboard is used on, and the width at which this card has wrapped
  // badly before.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(120);
  const narrow = await page.evaluate(() => {
    const row = [...document.querySelectorAll("#hub-page-home .hub-metric")].find(
      (m) => m.querySelector(".label-text").textContent === "Flow Rate"
    );
    const cells = [...row.querySelectorAll(".hub-metric-value")];
    const rects = cells.map((c) => c.getBoundingClientRect());
    return {
      sameLine: Math.abs(rects[0].top - rects[1].top) < 2,
      divider: getComputedStyle(cells[1]).borderLeftWidth,
      fitsCard: rects[1].right <= row.getBoundingClientRect().right + 1,
    };
  });
  check(narrow.sameLine, "at 360px the two units still sit side by side");
  eq(narrow.divider, "1px", "with a hairline between them");
  check(narrow.fitsCard, "and neither value overflows the card");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(120);

  await page.evaluate(() => document.querySelector('.hub-nav-item[data-page="service"]').click());
  await page.waitForTimeout(100);
}

// The page's own identity: the tab title, and the two icon links the
// firmware serves (components/web_icons). ESPHome's generated <head>
// carries an empty <link rel=icon href=data:>, so the tab icon has to be
// the existing link repointed - a second rel=icon would leave the browser
// to pick, and it picks the empty one.
async function testPageIdentity(page) {
  const identity = await page.evaluate(() => ({
    title: document.title,
    icons: [...document.head.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute("href")),
    touch: [...document.head.querySelectorAll('link[rel="apple-touch-icon"]')].map((l) => l.getAttribute("href")),
  }));
  eq(identity.title, "Water Telemetry Hub", "the tab shows the device's name");
  eq(identity.icons.join(","), "/favicon.svg", "exactly one tab icon, pointing at the served SVG");
  eq(identity.touch.join(","), "/apple-touch-icon.png", "exactly one home-screen icon, pointing at the served PNG");
}

async function testPulseMeterNeverFallsIntoOther(page) {
  console.log("a pulse-meter payload without sorting metadata still belongs to its meter");
  await page.evaluate(() => {
    // Seen on a real reconnect: the entity is otherwise complete, but
    // sorting_group is absent. Its stable firmware name is enough to
    // recover the group and must never create the generic Other card.
    window.__emit("state", {
      id: "sensor/Pulse Meter 1 Total Consumption",
      domain: "sensor",
      name: "Pulse Meter 1 Total Consumption",
      sorting_weight: 10,
      value: 12345.002,
      uom: "m³",
      state: "12345.002 m³",
    });
  });
  await page.waitForTimeout(80);
  const otherGroups = await page.evaluate(
    () =>
      [...document.querySelectorAll(".hub-meter-card-header-label, .hub-section-label")].filter(
        (el) => el.textContent.trim() === "Other"
      ).length
  );
  eq(otherGroups, 0, "a known pulse-meter entity never creates an Other group");
  // The recovered group must actually be used, not merely "not Other" -
  // a value silently dropped nowhere would pass the check above too.
  const recovered = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".hub-meter-card")].find(
      (c) => c.querySelector(".hub-meter-card-header-label")?.textContent.trim() === "Fő vízóra"
    );
    return card ? card.textContent.includes("12345") : false;
  });
  check(recovered, "the recovered value actually reaches its meter's own card (Pulse Meter 1, \"Fő vízóra\")");

  // Same recovery, the OTHER half of the regex (a Modbus device, not a
  // pulse meter) and a non-numeric domain - the fix must not be
  // accidentally scoped to one entity type or one sensor domain.
  await page.evaluate(() => {
    window.__emit("state", {
      id: "binary_sensor/Modbus Device 1 Online",
      domain: "binary_sensor",
      name: "Modbus Device 1 Online",
      sorting_weight: 15,
      value: true,
    });
  });
  await page.waitForTimeout(80);
  const otherGroupsAfterModbus = await page.evaluate(
    () =>
      [...document.querySelectorAll(".hub-meter-card-header-label, .hub-section-label")].filter(
        (el) => el.textContent.trim() === "Other"
      ).length
  );
  eq(otherGroupsAfterModbus, 0, "a known Modbus-device entity never creates an Other group either");
}

// --- the tests ------------------------------------------------------------

async function run() {
  const workdir = await mkdtemp(join(tmpdir(), "hub-e2e-"));
  for (const file of ["dashboard.js", "dashboard.css"]) {
    await copyFile(join(repo, "web", file), join(workdir, file));
  }
  await copyFile(join(here, "fixture.html"), join(workdir, "index.html"));

  const chromium = await loadChromium();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });
  await page.goto(pathToFileURL(join(workdir, "index.html")).href);
  await page.waitForTimeout(100);
  await bootstrap(page);

  await testPageIdentity(page);
  await testPulseMeterNeverFallsIntoOther(page);
  await testBothFlowRateUnitsOnTheCard(page);
  await testExactDisplay(page);
  await testAtomicUpdate(page);
  await testMultiClientRace(page);
  await testRefusalIsReported(page);
  await testStrictInputValidation(page);
  await testResolutionValidation(page);
  await testDeleteConfirmationTellsTheTruth(page);
  await testUnavailableReadingShowsNoStaleValue(page);
  await testNewDeviceRowPrefillsTheDetectedType(page);
  await testAddRefusesTheWrongDeviceType(page);
  await testMismatchBadgeAppearsOnItsOwn(page);
  await testLiveCollisionBarrierUpdatesImmediately(page);
  await testRefusedAddressChangeIsReported(page);
  await testAddressChangeOnAContendedAddressIsRefused(page);
  await testAddressChangeOntoAnOccupiedAddressIsRefused(page);
  await testUnverifiedAddressChangePointsAtTheScan(page);
  await testAcceptedAddressChangeIsSilent(page);

  await testTypedDraftSurvivesBlur(page);
  await testOutOfRangeDraftSurvivesBlur(page);
  await testReadingCanAlwaysExpressTheCurrentTotal(page);
  await testCorrectionAfterRejectionSendsTheNewValue(page);
  await testSwitchingRowsDiscardsAnUnsavedReadingDraft(page);
  await testSaveAppliesADirtyReadingWithItsOwnConfirmation(page);
  await testSaveIsDisabledUntilSomethingActuallyChanged(page);
  await testPressureSaveAppliesADirtyReadingWithItsOwnConfirmation(page);
  await testPressureSaveIsDisabledUntilSomethingActuallyChanged(page);
  await testDeclinedReadingConfirmationCancelsAddressChangeToo(page);
  await testZeroFlowTimeoutOnlyAppliesOnSave(page);
  await testZeroFlowTimeoutRejectsOutOfRangeOnSave(page);
  await testResolutionMessageIsPerMeter(page);
  await testNoOldValueFlashDuringUpdate(page);
  await testRefusalRestoresLiveValue(page);
  await testAnotherTabsResultIsNotOurs(page);

  check(pageErrors.length === 0, `no uncaught page errors (got: ${pageErrors.join(" | ")})`);

  await browser.close();
  console.log(`\n${checks} checks, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

async function openAndGet(page, displayNameValue) {
  const opened = await page.evaluate((label) => {
    const inputs = [...document.querySelectorAll("td.hub-pressure-name input")];
    const target = inputs.find((i) => i.value === label);
    if (!target) return false;
    const row = target.closest("tr");
    const editBtn = row.querySelector(".hub-pressure-edit-btn");
    editBtn.click();
    const expanded = row.nextElementSibling;
    window.__row = row;
    window.__expanded = expanded;
    window.__reading = expanded.querySelector("input.hub-reading-input");
    window.__update = [...expanded.querySelectorAll("button")].find((b) => b.textContent === "Update");
    return !!(window.__reading && window.__update);
  }, displayNameValue);
  check(opened, `opened the "${displayNameValue}" row with a Reading field and an Update button`);
}

async function testExactDisplay(page) {
  console.log("exact display (no float rounding)");
  await openAndGet(page, "Kerti óra");
  const shown = await page.evaluate(() => window.__reading.value);
  // The device's own float sensor state string says 12345.123047; the
  // exact channel says 12345123456 ml. The reading shown must be the
  // second one.
  eq(shown, "12345.123456", "flow meter Reading shows the exact millilitre value, not the float32 state string");
  const correction = await page.evaluate(() => window.__expanded.querySelector(".hub-pulsemeter-expanded-value").textContent);
  check(correction.includes("0.062691"), `correction shows the exact offset (got "${correction}")`);
  await page.evaluate(() => window.__row.querySelector(".hub-pressure-cancel-btn").click());
}

async function testAtomicUpdate(page) {
  console.log("Update is a single value-carrying request");
  await openAndGet(page, "Fő vízóra");
  await page.evaluate(() => {
    window.__posts.length = 0;
    window.__alerts.length = 0;
    window.__confirmAnswer = true;
    window.__reading.value = "12345,123";
    window.__reading.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const clicked = page.evaluate(() => window.__update.click());
  // The device answers on the shared result channel.
  await page.waitForTimeout(50);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "1|Pulse Meter 1|ok|12345,123" })
  );
  await clicked;
  await page.waitForTimeout(50);

  const posts = await page.evaluate(() => window.__posts);
  eq(posts.length, 1, `exactly one request per Update (got ${JSON.stringify(posts)})`);
  eq(
    posts[0] && posts[0].path,
    "/text/Pulse%20Meter%201%20Update/set?value=12345%2C123",
    "the one request is a set on the Update entity, carrying the typed value verbatim"
  );
  const alerts = await page.evaluate(() => window.__alerts);
  eq(alerts.length, 0, `a successful update raises nothing (got ${JSON.stringify(alerts)})`);
  // The typed value is on screen immediately, without waiting for the
  // device's own state push - and it is the exact value, not a rounded one.
  const shown = await page.evaluate(() => window.__reading.value);
  eq(shown, "12345.123", "the applied reading is shown right away");
  await page.evaluate(() => window.__row.querySelector(".hub-pressure-cancel-btn").click());
}

async function testMultiClientRace(page) {
  console.log("a second client cannot redirect an Update");
  await openAndGet(page, "Fő vízóra");
  await page.evaluate(() => {
    window.__posts.length = 0;
    window.__reading.value = "500.5";
    window.__reading.dispatchEvent(new Event("input", { bubbles: true }));
    // Somebody else (another tab, Home Assistant, a retry) sets the
    // device-side Reading number to something entirely different, right
    // between typing and pressing Update. Under the old two-request
    // design this is the value the Update button would have applied.
    window.__emit("state", { id: "number/Pulse Meter 1 Reading", value: 999 });
  });
  const clicked = page.evaluate(() => window.__update.click());
  await page.waitForTimeout(50);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "2|Pulse Meter 1|ok|500.5" })
  );
  await clicked;
  await page.waitForTimeout(50);
  const posts = await page.evaluate(() => window.__posts);
  eq(posts.length, 1, "still exactly one request");
  check(
    posts[0] && posts[0].path.endsWith("value=500.5"),
    `the request carries the typed value, not the one the other client staged (got "${posts[0] && posts[0].path}")`
  );
  await page.evaluate(() => window.__row.querySelector(".hub-pressure-cancel-btn").click());
}

async function testRefusalIsReported(page) {
  console.log("a refused update is reported, not silently swallowed");
  await openAndGet(page, "Kerti óra");
  await page.evaluate(() => {
    window.__posts.length = 0;
    window.__alerts.length = 0;
    window.__reading.value = "5.5";
    window.__reading.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const clicked = page.evaluate(() => window.__update.click());
  await page.waitForTimeout(50);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "3|Modbus Device 1|stale|5.5" })
  );
  await clicked;
  await page.waitForTimeout(50);
  const alerts = await page.evaluate(() => window.__alerts);
  eq(alerts.length, 1, `the refusal surfaces (got ${JSON.stringify(alerts)})`);
  check(alerts[0] && alerts[0].includes("hasn't answered"), `the message explains why (got "${alerts[0]}")`);
  // ...and the display was NOT optimistically moved to a value the
  // device never took.
  const shown = await page.evaluate(() => window.__reading.value);
  eq(shown, "12345.123456", "a refused update leaves the real reading on screen");
  await page.evaluate(() => window.__row.querySelector(".hub-pressure-cancel-btn").click());
}

// Changing a registered sensor's Modbus address reprograms the physical
// device over the bus, and that can fail - it has to answer to be
// reprogrammed, or the device puts the old address back. Without a
// reported outcome the change could simply "not take" with nothing on
// screen saying so, since the POST's own 200 only means the request was
// received.
async function startAddressChange(page, displayName, newAddress) {
  await openAndGet(page, displayName);
  return page.evaluate((address) => {
    window.__posts.length = 0;
    window.__alerts.length = 0;
    const input = window.__expanded.querySelector("input[type=number]");
    input.value = String(address);
    // A real person typing fires `input` as they go - needed now for
    // Save's own dirty-tracking (updateSaveEnabled()) to notice the
    // change and enable the button; a raw .value assignment alone,
    // exactly like this test used to do, leaves Save disabled and the
    // click below a no-op, same as a real disabled button ignores a
    // click.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    window.__row.querySelector(".hub-pressure-save-btn").click();
  }, newAddress);
}

// A Mismatch is not a scan finding: the live poll raises it when the
// device at a registered address turns out not to be the type the slot is
// configured for, so it arrives on its own, with no scan anywhere near
// it. The channel used to fall through to the generic render path, which
// returns early for the Add group - so the firmware could set the flag
// and the badge would appear only if something else happened to redraw
// the table.
// A scan-discovered row asks for two things: a name, which only a person
// can supply, and a device type, which the firmware just worked out by
// reading the device. Making someone re-derive the second is how a
// pressure transmitter ends up registered as a flow meter - and that is
// not cosmetic, since the slot would then poll a register block that
// means something else on that instrument.
async function testNewDeviceRowPrefillsTheDetectedType(page) {
  console.log("a discovered device arrives with its type already filled in");
  await page.evaluate(() => {
    const add = (id, domain, name, extra) =>
      window.__emit("state", {
        id,
        domain,
        name,
        sorting_group: "Modbus Devices",
        sorting_weight: 5,
        ...extra,
      });
    add("text/Modbus Devices Add Name", "text", "Modbus Devices Add Name", { value: "" });
    add("number/Modbus Devices Add Target Address", "number", "Modbus Devices Add Target Address", { value: 0 });
    add("select/Modbus Devices Add Device Type", "select", "Modbus Devices Add Device Type", {
      value: "Pressure",
      option: ["Pressure", "Flow"],
    });
    add("button/Modbus Devices Add", "button", "Modbus Devices Add", {});
    add("text_sensor/Modbus Devices Add Result", "text_sensor", "Modbus Devices Add Result", { value: "" });
  });
  // The real publication order: the scan publishes its ADDRESSES, the
  // types it worked out for them, and its Collisions CSV, then - and
  // only then - bumps Scan Generation once (water-telemetry-hub.yaml's
  // modbus_scan_finish; see web/dashboard.js's own "Scan Generation"
  // comment). Only that last event may trigger a render: emitting
  // Results/Types on their own must NOT put a row on screen yet - the
  // firmware used to publish them as three independently-rendered
  // events, and a browser that redraws on Results alone before Types
  // arrives shows an empty dropdown even though the types event that
  // would have filled it in is already on its way.
  await page.evaluate(() =>
    window.__emit("state", {
      id: "text_sensor/Modbus Devices Scan Results",
      domain: "text_sensor",
      name: "Modbus Devices Scan Results",
      sorting_group: "Modbus Devices",
      sorting_weight: 5,
      value: "20",
    })
  );
  await page.evaluate(() =>
    window.__emit("state", {
      id: "text_sensor/Modbus Devices Scan Device Types",
      domain: "text_sensor",
      name: "Modbus Devices Scan Device Types",
      sorting_group: "Modbus Devices",
      sorting_weight: 5,
      value: "20:Flow",
    })
  );
  await page.waitForTimeout(120);
  const beforeGeneration = await page.evaluate(
    () => [...document.querySelectorAll("tr.hub-pressure-row-new")].find((r) => r.textContent.includes("Modbus address: 20")) || null
  );
  check(!beforeGeneration, "Results and Types alone do not draw the row - only Scan Generation may");
  await page.evaluate(() =>
    window.__emit("state", {
      id: "sensor/Modbus Devices Scan Generation",
      domain: "sensor",
      name: "Modbus Devices Scan Generation",
      sorting_group: "Modbus Devices",
      sorting_weight: 5,
      value: 1,
    })
  );
  await page.waitForTimeout(120);
  const prefilled = await page.evaluate(() => {
    const row = [...document.querySelectorAll("tr.hub-pressure-row-new")].find((r) =>
      r.textContent.includes("Modbus address: 20")
    );
    if (!row) return null;
    window.__newRow = row;
    return {
      type: row.querySelector("select.hub-pressure-type-select").value,
      confirmDisabled: row.querySelector(".hub-pressure-save-btn").disabled,
    };
  });
  check(!!prefilled, "the discovered device shows up as a New row once Scan Generation fires");
  if (!prefilled) return;
  eq(prefilled.type, "Flow", "its type is already the one the device reported - not a later, separate update");
  // Still needs a name - the type being known does not make the row
  // complete, and Confirm must not become clickable on its own.
  check(prefilled.confirmDisabled, "but Confirm still waits for a name");

  // Reapplying the detected type on every render must not undo a
  // deliberate choice: the dropdown stays a starting point, not a lock.
  await page.evaluate(() => {
    const select = window.__newRow.querySelector("select.hub-pressure-type-select");
    select.value = "Pressure";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    window.__emit("state", { id: "text_sensor/Modbus Devices Scan Device Types", value: "20:Flow" });
    window.__emit("state", { id: "sensor/Modbus Devices Scan Generation", value: 2 });
  });
  await page.waitForTimeout(120);
  const afterManual = await page.evaluate(
    () => window.__newRow.querySelector("select.hub-pressure-type-select").value
  );
  eq(afterManual, "Pressure", "a hand-picked type survives the next render");
  // ...and put it back for the Add test that follows.
  await page.evaluate(() => {
    const select = window.__newRow.querySelector("select.hub-pressure-type-select");
    select.value = "Flow";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function testAddRefusesTheWrongDeviceType(page) {
  console.log("registering a device as the wrong type is refused, and said out loud");
  await page.evaluate(() => {
    window.__alerts.length = 0;
    const row = window.__newRow;
    const name = row.querySelector("input[type=text]");
    name.value = "Nyomás 3";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    // Override the pre-filled type with the wrong one, on purpose - the
    // dropdown stays editable, so the device itself has to be the one
    // that says no.
    const select = row.querySelector("select.hub-pressure-type-select");
    select.value = "Pressure";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    row.querySelector(".hub-pressure-save-btn").click();
  });
  await page.waitForTimeout(60);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Modbus Devices Add Result", value: "wrong_type" })
  );
  await page.waitForTimeout(80);
  const alerts = await page.evaluate(() => window.__alerts);
  eq(alerts.length, 1, `the refusal reaches the person who asked (got ${JSON.stringify(alerts)})`);
  check(alerts[0] && alerts[0].includes("not a Pressure"), `it names the type that was chosen (got "${alerts[0]}")`);
  check(alerts[0] && alerts[0].includes("Flow"), `and the type the device actually is (got "${alerts[0]}")`);
}

async function testMismatchBadgeAppearsOnItsOwn(page) {
  console.log("a mismatch raised by the poll shows up without a scan");
  const before = await page.evaluate(() => {
    const input = [...document.querySelectorAll("td.hub-pressure-name input")].find((i) => i.value === "Kerti óra");
    return input.closest("tr").querySelector(".hub-pressure-badge").textContent;
  });
  eq(before, "OK", "the row starts healthy");
  await page.evaluate(() =>
    window.__emit("state", {
      id: "text_sensor/Modbus Devices Scan Mismatches",
      domain: "text_sensor",
      name: "Modbus Devices Scan Mismatches",
      sorting_group: "Modbus Devices",
      sorting_weight: 60,
      value: "1",
    })
  );
  await page.waitForTimeout(80);
  const after = await page.evaluate(() => {
    const input = [...document.querySelectorAll("td.hub-pressure-name input")].find((i) => i.value === "Kerti óra");
    return input.closest("tr").querySelector(".hub-pressure-badge").textContent;
  });
  eq(after, "Mismatch", "the badge appears as soon as the device says so");
  // ...and clears again the same way, without a scan.
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Modbus Devices Scan Mismatches", value: "" })
  );
  await page.waitForTimeout(80);
  const cleared = await page.evaluate(() => {
    const input = [...document.querySelectorAll("td.hub-pressure-name input")].find((i) => i.value === "Kerti óra");
    return input.closest("tr").querySelector(".hub-pressure-badge").textContent;
  });
  eq(cleared, "OK", "and clears again when the device stops reporting it");
}

async function testLiveCollisionBarrierUpdatesImmediately(page) {
  console.log("a live collision updates badges and Home without waiting for a scan");
  await page.evaluate(() => {
    window.__emit("state", {
      id: "text_sensor/Modbus Devices Scan Collisions",
      domain: "text_sensor",
      name: "Modbus Devices Scan Collisions",
      sorting_group: "Modbus Devices",
      sorting_weight: 5,
      value: "1",
    });
  });
  await page.waitForTimeout(80);
  let badge = await page.evaluate(() => {
    const input = [...document.querySelectorAll("td.hub-pressure-name input")].find((i) => i.value === "Kerti óra");
    return input.closest("tr").querySelector(".hub-pressure-badge").textContent;
  });
  eq(badge, "OK", "the shared CSV alone does not expose a partial scan publication");

  await page.evaluate(() =>
    window.__emit("state", {
      id: "sensor/Modbus Devices Live Collision Generation",
      domain: "sensor",
      name: "Modbus Devices Live Collision Generation",
      sorting_group: "Modbus Devices",
      sorting_weight: 5,
      value: 1,
    })
  );
  await page.waitForTimeout(80);
  badge = await page.evaluate(() => {
    const input = [...document.querySelectorAll("td.hub-pressure-name input")].find((i) => i.value === "Kerti óra");
    return input.closest("tr").querySelector(".hub-pressure-badge").textContent;
  });
  eq(badge, "Collision", "the live barrier shows the collision without any Scan Generation event");

  await page.evaluate(() => document.querySelector('.hub-nav-item[data-page="home"]').click());
  await page.waitForTimeout(80);
  const hidden = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#hub-page-home .hub-meter-card")];
    const card = cards.find((c) => c.querySelector(".hub-meter-card-header-label")?.textContent.trim() === "Kerti óra");
    return [...card.querySelectorAll(".hub-metric-value .val")].map((v) => v.textContent);
  });
  check(hidden.length > 0 && hidden.every((v) => v === "--"), `all collided Home readings are hidden (got ${hidden})`);

  await page.evaluate(() => {
    window.__emit("state", { id: "text_sensor/Modbus Devices Scan Collisions", value: "" });
    window.__emit("state", { id: "sensor/Modbus Devices Live Collision Generation", value: 2 });
  });
  await page.waitForTimeout(80);
  const restored = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#hub-page-home .hub-meter-card")];
    const card = cards.find((c) => c.querySelector(".hub-meter-card-header-label")?.textContent.trim() === "Kerti óra");
    return [...card.querySelectorAll(".hub-metric-value .val")].map((v) => v.textContent);
  });
  check(restored.some((v) => v !== "--"), `Home readings return when live collision clears (got ${restored})`);
  await page.evaluate(() => document.querySelector('.hub-nav-item[data-page="service"]').click());
}

async function testRefusedAddressChangeIsReported(page) {
  console.log("a sensor that will not take a new address says so");
  await startAddressChange(page, "Kerti óra", 7);
  await page.waitForTimeout(50);
  const postOrder = await page.evaluate(() => window.__posts.map((p) => p.path));
  const armIndex = postOrder.findIndex((path) => path.includes("Address%20Change%20Request/set?value=1%2C7%2C"));
  const addressIndex = postOrder.findIndex((path) => path.includes("Modbus%20Address/set?value=7"));
  check(armIndex >= 0, "a one-use old/new/nonce authorization is sent first");
  check(addressIndex > armIndex, "the address value is sent only after its safety authorization");
  const posted = addressIndex >= 0;
  check(posted, "the new address is sent to the device");
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "11|Modbus Device 1|no_reply|7" })
  );
  await page.waitForTimeout(80);
  const alerts = await page.evaluate(() => window.__alerts);
  eq(alerts.length, 1, `the refusal surfaces (got ${JSON.stringify(alerts)})`);
  check(
    alerts[0] && alerts[0].includes("1") && alerts[0].includes("7"),
    `the message names both addresses (got "${alerts[0]}")`
  );
  check(
    alerts[0] && /RS485/i.test(alerts[0]),
    `and points at the reason it could not be reprogrammed (got "${alerts[0]}")`
  );
}

// Reprogramming an address that two devices share cannot work: a Modbus
// write goes to the address, so both receive it. The firmware refuses to
// write anything, and the message has to say what to do instead - "try
// again" would be advice that cannot succeed.
async function testAddressChangeOnAContendedAddressIsRefused(page) {
  console.log("an address two devices share is not reprogrammed at all");
  await startAddressChange(page, "Kerti óra", 100);
  await page.waitForTimeout(50);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "21|Modbus Device 1|contended|100" })
  );
  await page.waitForTimeout(80);
  const alerts = await page.evaluate(() => window.__alerts);
  eq(alerts.length, 1, `the refusal is reported (got ${JSON.stringify(alerts)})`);
  check(alerts[0] && /nothing was written/i.test(alerts[0]), `it says nothing was written (got "${alerts[0]}")`);
  check(alerts[0] && /disconnect one/i.test(alerts[0]), `and gives the only remedy there is (got "${alerts[0]}")`);
}

async function testAddressChangeOntoAnOccupiedAddressIsRefused(page) {
  console.log("moving onto an address something already answers on is refused");
  await startAddressChange(page, "Kerti óra", 12);
  await page.waitForTimeout(50);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "22|Modbus Device 1|occupied|12" })
  );
  await page.waitForTimeout(80);
  const alerts = await page.evaluate(() => window.__alerts);
  eq(alerts.length, 1, `the refusal is reported (got ${JSON.stringify(alerts)})`);
  check(alerts[0] && alerts[0].includes("12"), `it names the address that is taken (got "${alerts[0]}")`);
  check(alerts[0] && /Scan Bus/i.test(alerts[0]), `and how to find a free one (got "${alerts[0]}")`);
}

async function testUnverifiedAddressChangePointsAtTheScan(page) {
  console.log("a sensor that answers on neither address is not called a failure");
  await startAddressChange(page, "Kerti óra", 8);
  await page.waitForTimeout(50);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "13|Modbus Device 1|unverified|8" })
  );
  await page.waitForTimeout(80);
  const alerts = await page.evaluate(() => window.__alerts);
  eq(alerts.length, 1, `the uncertain outcome is reported (got ${JSON.stringify(alerts)})`);
  // The firmware keeps the new address in this case, so the message must
  // not claim the change failed - it has to send the reader to the scan.
  check(alerts[0] && /Scan Bus/i.test(alerts[0]), `it points at the bus scan (got "${alerts[0]}")`);
  check(
    alerts[0] && !/unchanged/i.test(alerts[0]),
    `and does not claim the address was left alone (got "${alerts[0]}")`
  );
}

async function testAcceptedAddressChangeIsSilent(page) {
  console.log("an accepted address change says nothing");
  await startAddressChange(page, "Kerti óra", 9);
  await page.waitForTimeout(50);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "12|Modbus Device 1|ok|9" })
  );
  await page.waitForTimeout(80);
  const alerts = await page.evaluate(() => window.__alerts);
  eq(alerts.length, 0, `a successful reprogram is not announced (got ${JSON.stringify(alerts)})`);
}

async function testStrictInputValidation(page) {
  console.log("malformed input never reaches the device");
  await openAndGet(page, "Fő vízóra");
  for (const bad of ["12abc", "1,2,3", "12 345,678", "", "abc"]) {
    const result = await page.evaluate(async (value) => {
      window.__posts.length = 0;
      window.__alerts.length = 0;
      window.__reading.value = value;
      window.__reading.dispatchEvent(new Event("input", { bubbles: true }));
      await window.__update.click();
      return { posts: window.__posts.length, alerts: window.__alerts.slice() };
    }, bad);
    eq(result.posts, 0, `"${bad}" sends nothing`);
    eq(result.alerts.length, 1, `"${bad}" explains the refusal`);
  }
  await page.evaluate(() => window.__row.querySelector(".hub-pressure-cancel-btn").click());
}

async function testResolutionValidation(page) {
  console.log("a reading finer than the meter's resolution is refused");
  await openAndGet(page, "Fő vízóra");
  const tooFine = await page.evaluate(async () => {
    window.__posts.length = 0;
    window.__alerts.length = 0;
    window.__reading.value = "12345.000001"; // 1 ml on a meter that counts litres
    window.__reading.dispatchEvent(new Event("input", { bubbles: true }));
    await window.__update.click();
    return { posts: window.__posts.length, alerts: window.__alerts.slice() };
  });
  eq(tooFine.posts, 0, "a sub-pulse reading is never sent");
  check(
    tooFine.alerts[0] && tooFine.alerts[0].includes("0.001"),
    `the message names the meter's own resolution (got "${tooFine.alerts[0]}")`
  );
  await page.evaluate(() => window.__row.querySelector(".hub-pressure-cancel-btn").click());

  // The flow meter genuinely measures to the millilitre, so the very same
  // number of decimals must be accepted there - the rule is each meter's
  // own step, not a hardcoded precision.
  await openAndGet(page, "Kerti óra");
  const fineIsFine = await page.evaluate(async () => {
    window.__posts.length = 0;
    window.__alerts.length = 0;
    window.__reading.value = "0.062691";
    window.__reading.dispatchEvent(new Event("input", { bubbles: true }));
    window.__update.click();
    return true;
  });
  void fineIsFine;
  await page.waitForTimeout(50);
  await page.evaluate(() =>
    window.__emit("state", { id: "text_sensor/Device Update Result", value: "4|Modbus Device 1|ok|0.062691" })
  );
  await page.waitForTimeout(80);
  const state = await page.evaluate(() => ({ posts: window.__posts.slice(), alerts: window.__alerts.slice() }));
  eq(state.alerts.length, 0, `a millilitre reading is fine on the flow meter (got ${JSON.stringify(state.alerts)})`);
  eq(state.posts.length, 1, "and it is sent");
  await page.evaluate(() => window.__row.querySelector(".hub-pressure-cancel-btn").click());
}

async function testDeleteConfirmationTellsTheTruth(page) {
  console.log("Delete says what Delete does");
  const message = await page.evaluate(() => {
    window.__confirms.length = 0;
    window.__confirmAnswer = false;
    const inputs = [...document.querySelectorAll("td.hub-pressure-name input")];
    const row = inputs.find((i) => i.value === "Fő vízóra").closest("tr");
    row.querySelector(".hub-pressure-del-btn").click();
    return window.__confirms[0] || "";
  });
  check(
    /reset to zero|cannot be recovered/i.test(message),
    `the pulse meter Delete dialog states the data loss (got "${message}")`
  );
  check(
    !/pick up where it left off|keep running/i.test(message),
    `...and no longer promises the opposite (got "${message}")`
  );
}

async function testUnavailableReadingShowsNoStaleValue(page) {
  console.log("an unavailable reading shows nothing, not the last exact value");
  await page.evaluate(() => {
    window.__emit("state", { id: "sensor/Modbus Device 1 Total Consumption", value: null, state: "" });
  });
  await page.waitForTimeout(120);
  await openAndGet(page, "Kerti óra");
  const shown = await page.evaluate(() => window.__reading.value);
  eq(shown, "--", "a meter with no current reading shows the unavailable marker");
  await page.evaluate(() => window.__row.querySelector(".hub-pressure-cancel-btn").click());
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
