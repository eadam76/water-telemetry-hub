#!/usr/bin/env python3
"""Asserts the numeric contracts of the meter entities against the real,
fully-substituted ESPHome configuration.

These few numbers - how many decimals a reading is published with, how
fine a value its input field accepts, how large a reading may be - decide
whether a measurement survives the trip to the screen intact. They have
regressed repeatedly and always silently: a reading displayed to three
decimals when the meter reports five looks perfectly plausible, and the
only way anyone found out was by comparing it against the device by hand.

Nothing else checks them. The C++ suite tests the code the values flow
through, and the browser suite tests what the dashboard does with what it
is given, but both are fed fixtures - neither one reads the firmware's
own configuration. This does, by running `esphome config` and inspecting
the result, so a change to any of these values has to be a deliberate one
that also changes this file.

Run via tests/run.sh, or directly:  python3 tests/check_config.py
"""

import subprocess
import sys

import yaml


class Loader(yaml.SafeLoader):
    """`esphome config` emits tags like !lambda and !secret - keep the
    payload, drop the tag."""


Loader.add_multi_constructor("!", lambda loader, suffix, node: None)
Loader.add_multi_constructor("tag:", lambda loader, suffix, node: None)


# Warnings ESPHome itself raised while processing the config. Kept
# alongside the parsed document because some of them are the only evidence
# of a problem that the OUTPUT no longer shows - ESPHome silently repairs
# the config and warns, so the repaired document looks perfect.
esphome_warnings = []


def load_config(path="water-telemetry-hub.yaml"):
    result = subprocess.run(
        ["esphome", "config", path], capture_output=True, text=True, check=True
    )
    esphome_warnings.extend(
        ln for ln in (result.stdout + result.stderr).splitlines() if ln.startswith("WARNING ")
    )
    # esphome prints INFO lines before the document itself.
    lines = [ln for ln in result.stdout.splitlines() if not ln.startswith("INFO ")]
    return yaml.load("\n".join(lines), Loader=Loader)


failures = []
checks = 0


def check(condition, message):
    global checks
    checks += 1
    if not condition:
        failures.append(message)


def entities(config, domain):
    return {e.get("id"): e for e in config.get(domain, []) if isinstance(e, dict)}


def decimals_of_step(step):
    """How many decimals a step permits: 0.001 -> 3, 1e-06 -> 6."""
    text = repr(float(step))
    if "e" in text:
        return -int(text.split("e")[1])
    return len(text.split(".")[1].rstrip("0"))


def main():
    config = load_config()
    sensors = entities(config, "sensor")
    numbers = entities(config, "number")

    # --- the invariant that matters most -----------------------------------
    # A meter's Reading field decides what precision someone may type; its
    # Total Consumption decides what precision they are shown. If those two
    # disagree, the meter either refuses values it then displays, or accepts
    # values it cannot show - both of which look like the software losing
    # data. Checked per meter rather than as a pair of constants, so it
    # holds however the individual numbers are chosen.
    meters = [
        ("meter1", "meter1_total_consumption", "meter1_sync_target"),
        ("meter2", "meter2_total_consumption", "meter2_sync_target"),
        ("slot1", "slot1_flow_total", "slot1_flow_reading"),
        ("slot2", "slot2_flow_total", "slot2_flow_reading"),
        ("slot3", "slot3_flow_total", "slot3_flow_reading"),
        ("slot4", "slot4_flow_total", "slot4_flow_reading"),
    ]
    for name, total_id, reading_id in meters:
        total = sensors.get(total_id)
        reading = numbers.get(reading_id)
        check(total is not None, f"{name}: no Total Consumption sensor {total_id}")
        check(reading is not None, f"{name}: no Reading number {reading_id}")
        if not total or not reading:
            continue
        shown = total["accuracy_decimals"]
        typed = decimals_of_step(reading["step"])
        check(
            shown == typed,
            f"{name}: Total Consumption shows {shown} decimals but Reading accepts "
            f"{typed} (step {reading['step']}) - one of them is lying to the user",
        )
        # A ceiling low enough to be reached is a ceiling that can lock the
        # correction field out of expressing the meter's own total.
        check(
            reading["max_value"] >= 1000000,
            f"{name}: Reading max {reading['max_value']} is low enough for a meter to grow past",
        )
        check(reading["min_value"] == 0, f"{name}: Reading min should be 0")

    # --- per-instrument resolutions ----------------------------------------
    # A pulse meter counts whole litres; 0.001 m³ is genuinely the finest
    # thing it can measure and anything beyond it would be invented.
    for meter in ("meter1", "meter2"):
        reading = numbers.get(f"{meter}_sync_target")
        if reading:
            check(
                float(reading["step"]) == 0.001,
                f"{meter}: Reading step {reading['step']} does not match one pulse (1 litre)",
            )

    # The T3-1-2-H reports its total to the millilitre and its instant rate
    # as a bare float - neither has a coarser quantum to round to.
    for slot in ("slot1", "slot2", "slot3", "slot4"):
        reading = numbers.get(f"{slot}_flow_reading")
        if reading:
            check(
                float(reading["step"]) == 1e-06,
                f"{slot}: Reading step {reading['step']} does not match the meter's millilitre resolution",
            )
        rate = sensors.get(f"{slot}_flow_rate")
        if rate:
            check(
                rate["accuracy_decimals"] >= 6,
                f"{slot}: Flow Rate shows only {rate['accuracy_decimals']} decimals - the meter "
                "sends more than that (e.g. 0.12345 m³/h would display as 0.123)",
            )
        offset = sensors.get(f"{slot}_flow_offset")
        total = sensors.get(f"{slot}_flow_total")
        if offset and total:
            check(
                offset["accuracy_decimals"] == total["accuracy_decimals"],
                f"{slot}: Correction Offset shows {offset['accuracy_decimals']} decimals against "
                f"Total Consumption's {total['accuracy_decimals']} - a real correction could round to 0.000",
            )

    # --- both flow-rate units, per meter -----------------------------------
    # Water is quoted in m³/h and in L/min depending on who is asking, so
    # each meter publishes both and nothing downstream has to convert.
    # The converted one must not lose the resolution of the one it comes
    # from: L/min is ~16.7x the m³/h number and so needs one decimal
    # fewer, m³/h is ~16.7x smaller than the L/min number and needs about
    # two more.
    rate_pairs = [
        # (name, native id, native unit, converted id, converted unit,
        #  minimum decimals the converted one needs)
        ("meter1", "meter1_flow_rate", "L/min", "meter1_flow_rate_m3h", "m³/h", 2),
        ("meter2", "meter2_flow_rate", "L/min", "meter2_flow_rate_m3h", "m³/h", 2),
        ("slot1", "slot1_flow_rate", "m³/h", "slot1_flow_rate_lpm", "L/min", -1),
        ("slot2", "slot2_flow_rate", "m³/h", "slot2_flow_rate_lpm", "L/min", -1),
        ("slot3", "slot3_flow_rate", "m³/h", "slot3_flow_rate_lpm", "L/min", -1),
        ("slot4", "slot4_flow_rate", "m³/h", "slot4_flow_rate_lpm", "L/min", -1),
    ]
    for name, native_id, native_uom, other_id, other_uom, extra in rate_pairs:
        native = sensors.get(native_id)
        other = sensors.get(other_id)
        check(native is not None, f"{name}: no flow rate sensor {native_id}")
        check(other is not None, f"{name}: no second-unit flow rate sensor {other_id}")
        if not native or not other:
            continue
        check(
            native["unit_of_measurement"] == native_uom,
            f"{name}: {native_id} is in {native['unit_of_measurement']}, expected {native_uom}",
        )
        check(
            other["unit_of_measurement"] == other_uom,
            f"{name}: {other_id} is in {other['unit_of_measurement']}, expected {other_uom}",
        )
        # Both halves of a pair are the same physical quantity, so both
        # need the device class - Home Assistant uses it for unit
        # conversion and for how the value is charted, and an entity
        # without it behaves differently from its own sibling. Its unit
        # list is closed, too: volume_flow_rate accepts "L/min" and
        # "m³/h" exactly as spelled above and nothing else, so a unit
        # rewritten for looks would cost the entity its statistics.
        for entity_id, entity in ((native_id, native), (other_id, other)):
            check(
                entity.get("device_class") == "volume_flow_rate",
                f"{name}: {entity_id} has device_class {entity.get('device_class')!r}, expected "
                "'volume_flow_rate' - without it Home Assistant treats it differently from the "
                "same measurement's other unit",
            )
        needed = native["accuracy_decimals"] + extra
        check(
            other["accuracy_decimals"] >= needed,
            f"{name}: {other_id} shows {other['accuracy_decimals']} decimals but needs at least "
            f"{needed} to carry {native_id}'s own resolution through the unit conversion",
        )
        # The dashboard strips a trailing "(unit)" from the label, so the
        # two rows read as one measurement in two units - that only works
        # if the name really does end in its own unit. ESPHome rewrites
        # "/" inside a NAME to U+2044 FRACTION SLASH (its REST/SSE paths
        # are built from names), while leaving the unit's own slash
        # alone - so the comparison has to undo that, exactly as
        # metricLabel() does in web/dashboard.js.
        check(
            other["name"].replace("\u2044", "/").endswith(f"({other_uom})"),
            f"{name}: {other_id} is named {other['name']!r} - the dashboard expects it to end in "
            f"'({other_uom})' so the card can drop the duplicate unit from the label",
        )

    # --- the total is correctable in both directions ------------------------
    # The physical meter is the authority: its reading is taken by hand
    # from time to time and the Reading/Update field corrects this total
    # to match, in whichever direction it has drifted. total_increasing
    # cannot express that - it reads any decrease as the meter having been
    # replaced and continues the sum from the new value, so one downward
    # correction would book the meter's entire total as consumption in a
    # single step. Asserted rather than commented because the two spellings
    # differ by one word and the damage only shows up in Home Assistant,
    # weeks later, as water nobody used.
    for name, total_id in [(m[0], m[1]) for m in meters]:
        total = sensors.get(total_id)
        if not total:
            continue
        check(
            total.get("state_class") == "total",
            f"{name}: {total_id} has state_class {total.get('state_class')!r} - a total that can be corrected "
            "downward must be 'total', not 'total_increasing', or Home Assistant reads the correction as a "
            "meter reset and invents the whole reading as consumption",
        )

    # --- no plain "/" in any entity name -----------------------------------
    # ESPHome builds its REST/SSE paths out of entity names, so a "/" inside
    # one is reserved: it rewrites the name to U+2044 FRACTION SLASH, warns,
    # and from ESPHome 2027.7.0 refuses the config outright. The names in
    # this project carry U+2044 directly, which makes the resulting entity
    # name identical while leaving nothing to warn about.
    #
    # Checked through ESPHome's own warning, not through the parsed config:
    # by the time the document exists the name has already been repaired, so
    # the output of a config with this problem is indistinguishable from one
    # without it. The warning is the only place it shows. (Units keep their
    # ordinary slash - only NAMES form paths.)
    path_warnings = [w for w in esphome_warnings if "URL path separator" in w]
    check(
        not path_warnings,
        f"{len(path_warnings)} entity name(s) still contain a plain '/' - ESPHome reserves it as a path "
        f"separator and will reject this config from 2027.7.0. Use U+2044 FRACTION SLASH, which is what it "
        f"rewrites the name to anyway: {path_warnings[:1]}",
    )

    # --- what Home Assistant is allowed to see -----------------------------
    # The dashboard is the management surface; Home Assistant is a consumer
    # of readings. Every entity that can change the device's configuration
    # (or is plumbing for the dashboard) is internal: true, which keeps it
    # out of the native API - and the web server carries include_internal
    # so the dashboard still gets it. What remains visible is opt-in
    # (disabled_by_default), read-only, and named for what the slot is, not
    # for what it was when only pressure transmitters existed. Asserted
    # because each of these is one forgotten line away from a Delete
    # button on a Home Assistant tile.
    check(
        config.get("web_server", {}).get("include_internal") is True,
        "web_server.include_internal must be true - internal entities are what the dashboard runs on",
    )
    exposed_actions = []
    writable_domains = ("button", "number", "select", "switch", "text")
    for domain in writable_domains:
        for e in config.get(domain, []):
            if not isinstance(e, dict) or "name" not in e:
                continue
            if not e.get("internal") and e["name"] != "Reboot Device":
                exposed_actions.append(f"{domain} '{e['name']}'")
    check(
        not exposed_actions,
        f"{len(exposed_actions)} entities that change the device's configuration are exposed to Home "
        f"Assistant - only Reboot Device may be: {exposed_actions[:5]}",
    )
    all_domains = writable_domains + ("sensor", "binary_sensor", "text_sensor")
    visible = [
        (domain, e)
        for domain in all_domains
        for e in config.get(domain, [])
        if isinstance(e, dict) and "name" in e and not e.get("internal")
    ]
    enabled = [f"{d} '{e['name']}'" for d, e in visible if not e.get("disabled_by_default")]
    check(
        not enabled,
        f"{len(enabled)} entities are enabled by default in Home Assistant - the principle is opt-in for "
        f"every one of them: {enabled[:5]}",
    )
    stale = [f"{d} '{e['name']}'" for d, e in visible if e["name"].startswith("Pressure Sensor")]
    check(
        not stale,
        f"{len(stale)} visible entities still carry the 'Pressure Sensor' slot name from before Flow slots "
        f"existed: {stale[:5]}",
    )
    factory = [f"{d} '{e['name']}'" for d, e in visible if "factory" in e["name"].lower()]
    check(not factory, f"a factory-reset entity is exposed: {factory}")
    for d, e in visible:
        if e["name"].endswith("Correction Offset"):
            check(
                e.get("entity_category") != "diagnostic",
                f"{e['name']} is filed under diagnostics - it is part of the reading, not of the device's health",
            )
    check(
        any(e["name"].endswith("Correction Offset") for _, e in visible),
        "no Correction Offset sensor is visible to Home Assistant",
    )

    # --- every internal entity is still a real dashboard citizen ----------
    # internal: true only keeps an entity out of the native API (Home
    # Assistant) - water-telemetry-hub.yaml's web_server: include_internal
    # is what keeps it reachable by THIS custom dashboard, over the same
    # local REST/SSE API as everything else. Every other internal: true
    # entity in this codebase deliberately still carries a name: and a
    # web_server: sorting_group_id, exactly so it renders as a normal,
    # correctly-grouped row there - one without either silently falls into
    # the dashboard's generic "Other" fallback card, labeled with its raw
    # id instead of a real name (packages/water_meter.yaml's pulse_meter
    # `total:` sub-sensor once had neither, and showed up labeled
    # "meter1_pulse_total" under "Other" even before the meter was
    # registered - that sub-sensor exists and starts publishing from boot,
    # independent of the app-level Registered flag entirely).
    def check_ungrouped(domain, e, into):
        if not isinstance(e, dict) or not e.get("internal"):
            return
        eid = e.get("id", "?")
        if not e.get("name"):
            into.append(f"{domain} '{eid}' (no name)")
        elif not (e.get("web_server") or {}).get("sorting_group_id"):
            into.append(f"{domain} '{e['name']}' (no web_server sorting_group_id)")

    ungrouped_internal = []
    for domain in all_domains:
        for e in config.get(domain, []):
            check_ungrouped(domain, e, ungrouped_internal)
            # A platform's own built-in sub-sensor (e.g. pulse_meter's
            # `total:`) is published to the dashboard as its own SSE
            # entity, exactly like a standalone one - but `esphome config`
            # keeps it nested under its parent's dict, one level deeper
            # than every entry this loop otherwise sees, so it needs its
            # own check rather than silently going unexamined.
            if isinstance(e, dict) and isinstance(e.get("total"), dict):
                check_ungrouped(domain, e["total"], ungrouped_internal)
    check(
        not ungrouped_internal,
        f"{len(ungrouped_internal)} internal entities have no name and/or web_server sorting_group_id, so this "
        f"dashboard has nowhere to put them but its 'Other' fallback: {ungrouped_internal[:5]}",
    )

    # --- no global of a type this project declares ------------------------
    # The generated main.cpp declares every global BEFORE it includes the
    # project's own headers, so a global whose type lives in
    # include/rs485_modbus.h or include/volume.h fails to compile - only
    # in the real build, which nothing else here runs. Per-slot state of
    # a project type goes behind an accessor in the header instead
    # (rs485_modbus::slot_link).
    own_types = [
        f"{g.get('id')}: {g.get('type')}"
        for g in config.get("globals", [])
        if isinstance(g, dict) and str(g.get("type", "")).split("::")[0] in ("rs485_modbus", "volume")
    ]
    check(
        not own_types,
        f"{len(own_types)} global(s) use a type from the project's own headers, which main.cpp includes only "
        f"after the globals block - keep such state behind a header accessor instead: {own_types[:3]}",
    )

    print(f"{checks} checks, {len(failures)} failures")
    for message in failures:
        print(f"  FAIL {message}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
