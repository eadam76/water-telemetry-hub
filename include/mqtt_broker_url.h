#pragma once

// Parses the single "MQTT Broker" text field (water-collector.yaml) into
// a host and a port, so the dashboard doesn't need a separate Port field
// at all - direct feedback, 2026-08-15: "A portszámot el is engedhetjük,
// meg lehet adni az URL-ben is csak a hint tegye egyértelművé" (the port
// field can go, it can be given in the URL instead, just make the hint
// clear about it).
//
// Accepts whatever shape someone reasonably types:
//   "homeassistant.local"              -> host=homeassistant.local, port=1883
//   "homeassistant.local:1884"         -> host=homeassistant.local, port=1884
//   "mqtt://homeassistant.local:1884"  -> same, scheme stripped
//   "mqtts://homeassistant.local"      -> scheme stripped, still port 1883
//     (this project doesn't implement MQTT-over-TLS - an "mqtts://"/
//     "ssl://" prefix is accepted syntactically so it doesn't error out,
//     but nothing about the actual connection changes because of it;
//     the dashboard's own hint text says so explicitly, not left to be
//     discovered the hard way).
//
// Deliberately NOT in the rs485_modbus:: namespace - unrelated domain,
// same reasoning water-collector.yaml's own includes: comment gives for
// keeping each hand-written helper in its own header.
#include <string>
#include <cctype>
#include <cstdlib>

namespace mqtt_broker_url {

inline void parse(const std::string &raw, std::string &host_out, uint16_t &port_out) {
  std::string s = raw;
  while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front()))) s.erase(s.begin());
  while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back()))) s.pop_back();

  auto scheme_pos = s.find("://");
  if (scheme_pos != std::string::npos) {
    s = s.substr(scheme_pos + 3);
  }
  // Defensive: strip a trailing path/query if someone pastes a full URL
  // rather than just a host - nothing else here expects one.
  auto slash_pos = s.find('/');
  if (slash_pos != std::string::npos) {
    s = s.substr(0, slash_pos);
  }

  auto colon_pos = s.rfind(':');
  if (colon_pos != std::string::npos) {
    host_out = s.substr(0, colon_pos);
    std::string port_str = s.substr(colon_pos + 1);
    int parsed = std::atoi(port_str.c_str());
    port_out = (parsed > 0 && parsed <= 65535) ? static_cast<uint16_t>(parsed) : 1883;
  } else {
    host_out = s;
    port_out = 1883;
  }
}

}  // namespace mqtt_broker_url
