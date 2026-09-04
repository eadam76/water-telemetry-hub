#pragma once

// Volume bookkeeping shared by both meter types (packages/water_meter.yaml
// and packages/pressure_sensor.yaml) - its own file rather than a corner
// of rs485_modbus.h because none of this is Modbus-specific.
//
// The rule this file exists to enforce: a volume is an exact integer
// number of MILLILITRES everywhere it is stored, corrected, persisted or
// parsed. Floats appear only in the HA-facing sensor state, never on the
// way back in - a float32 loses whole-litre precision around 16000 m3
// and millilitre precision past about 8 m3, so routing a reading through
// one anywhere else quietly changes the measurement.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>  // meter packages' set_action lambdas compare status strings against this file's conventions
#include <string>

#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/sensor/sensor.h"
#include "esphome/components/text_sensor/text_sensor.h"

namespace volume {

// --- Publishing only what changed ----------------------------------------
// Polling several devices a few times a second means most state pushes
// carry a value identical to the last one (a total that hasn't moved, an
// Online flag that's been true for hours) - pure cost on the SSE stream
// and the browser render it triggers. publish_state() has no such check
// of its own; these wrappers add it.
inline void publish_if_changed(esphome::sensor::Sensor *sensor, float value) {
  // NAN != NAN, so an unavailable reading would otherwise republish on
  // every poll - which is exactly the case a device that has gone
  // offline sits in.
  bool both_nan = std::isnan(value) && std::isnan(sensor->state);
  if (sensor->has_state() && (both_nan || sensor->state == value)) return;
  sensor->publish_state(value);
}

inline void publish_if_changed(esphome::binary_sensor::BinarySensor *sensor, bool value) {
  if (sensor->has_state() && sensor->state == value) return;
  sensor->publish_state(value);
}

// --- Publishing one meter's volumes --------------------------------------
// Both meter packages call this as their one place to publish volumes.
// The float sensors feed Home Assistant's statistics and the ESPHome
// API - fine for that, but a float32's spacing at 12345 m3 is already
// ~1 litre, too coarse for the dashboard's own display. `exact` carries
// the same two numbers as plain integer millilitres
// ("<total_ml>|<offset_ml>"); web/dashboard.js renders from this channel,
// not the float sensors. `offset` may be null for a meter with no
// separate Correction Offset sensor - the offset still travels on the
// exact channel either way.
inline void publish_volume(esphome::sensor::Sensor *total, esphome::sensor::Sensor *offset,
                           esphome::text_sensor::TextSensor *exact, int64_t total_ml, int64_t offset_ml) {
  char buf[48];
  snprintf(buf, sizeof(buf), "%lld|%lld", static_cast<long long>(total_ml), static_cast<long long>(offset_ml));
  float total_value = static_cast<float>(static_cast<double>(total_ml) / 1000000.0);
  float offset_value = static_cast<float>(static_cast<double>(offset_ml) / 1000000.0);
  // Skip only when EVERY channel already reads exactly this - checking
  // just the exact string let a NAN float (from a failed poll) survive
  // an unmoved total on the next successful poll, since the exact string
  // came back identical and the early return never restored the float.
  // The exact string must still be part of the check, not just the
  // floats: two different millilitre values can land on the same
  // float32, which is the whole reason that channel exists.
  bool total_current = total->has_state() && !std::isnan(total->state) && total->state == total_value;
  bool offset_current =
      offset == nullptr || (offset->has_state() && !std::isnan(offset->state) && offset->state == offset_value);
  if (exact->state == buf && total_current && offset_current) return;
  total->publish_state(total_value);
  if (offset != nullptr) offset->publish_state(offset_value);
  exact->publish_state(buf);
}

// --- Update outcome channel ----------------------------------------------
// A Reading Update is a single POST to a text entity, so the HTTP
// response can only say the request was received, never whether it was
// applied. Refusals (stale reading, malformed number, finer than the
// meter's resolution) are reported here instead, out of band - one
// shared sensor for the whole device: "<sequence>|<device>|<status>|<request>".
//
// The echoed request is what makes sharing one sensor safe: two clients
// updating the same meter at once would otherwise have a client accept
// the other's refusal as its own (device name alone can't tell them
// apart). Two clients sending the identical string are indistinguishable,
// but then the outcome is the same for both anyway. The echo goes last
// since the request is user-typed and may itself contain '|' - a reader
// splits the first three fields and takes the remainder verbatim. The
// leading sequence number keeps every publish distinct, so a repeated
// result is never swallowed as a "state didn't change" no-op.
inline void publish_update_result(esphome::text_sensor::TextSensor *result, const char *device, const char *status,
                                  const std::string &request) {
  static uint32_t sequence = 0;
  sequence++;
  char buf[160];
  snprintf(buf, sizeof(buf), "%u|%s|%s|%s", static_cast<unsigned int>(sequence), device, status, request.c_str());
  result->publish_state(buf);
}

// --- Exact decimal formatting/parsing for millilitre totals ---------------
// Convert exact integer millilitres to/from the decimal m3 string the
// dashboard shows and the user types - string-based throughout, no float
// anywhere in between, since a float32 can't even hold "12345.001"
// exactly.

// "12345.123456" / "12345,123456" -> millilitres, exactly. Returns false
// for anything that isn't a plain decimal number (no exponent, no
// thousands separators, no trailing junk), so a malformed or partial
// value can never be half-parsed into a plausible-looking reading. More
// than 6 decimals is refused rather than truncated - the extra digits
// would be a claim the instrument cannot make; the dashboard enforces
// the same rule against each meter's own step, this is the device-side
// backstop.
inline bool parse_m3_to_ml(const std::string &text, int64_t &out_ml) {
  size_t i = 0;
  size_t n = text.size();
  while (i < n && (text[i] == ' ' || text[i] == '\t')) i++;
  size_t end = n;
  while (end > i && (text[end - 1] == ' ' || text[end - 1] == '\t')) end--;
  if (i >= end) return false;
  bool negative = false;
  if (text[i] == '+' || text[i] == '-') {
    negative = text[i] == '-';
    i++;
  }
  uint64_t whole = 0;
  size_t whole_digits = 0;
  while (i < end && text[i] >= '0' && text[i] <= '9') {
    // Far beyond any meter's range - refuse rather than overflow. Twelve
    // whole digits is the most that still fits int64 after the x1e6 to
    // millilitres (1e18 < 9.2e18); a thirteenth would wrap.
    if (whole_digits >= 12) return false;
    whole = whole * 10 + static_cast<uint64_t>(text[i] - '0');
    whole_digits++;
    i++;
  }
  if (whole_digits == 0) return false;
  uint64_t frac = 0;
  size_t frac_digits = 0;
  if (i < end && (text[i] == '.' || text[i] == ',')) {
    i++;
    while (i < end && text[i] >= '0' && text[i] <= '9') {
      if (frac_digits >= 6) return false;  // finer than a millilitre - not a measurement, refuse it
      frac = frac * 10 + static_cast<uint64_t>(text[i] - '0');
      frac_digits++;
      i++;
    }
    if (frac_digits == 0) return false;  // "12." is not a number
  }
  if (i != end) return false;  // trailing junk ("12abc", "1,2,3", "12 345,678")
  for (size_t k = frac_digits; k < 6; k++) frac *= 10;
  int64_t ml = static_cast<int64_t>(whole * 1000000ULL + frac);
  out_ml = negative ? -ml : ml;
  return true;
}

}  // namespace volume
