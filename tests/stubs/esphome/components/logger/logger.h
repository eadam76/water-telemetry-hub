#pragma once
#include <cstdint>
#include "esphome/core/log.h"
namespace esphome {
namespace logger {

// Deliberately faithful to the real ESPHome header, including the part
// that bites: level_for() is declared `inline` with NO definition
// reachable from outside the logger's own translation unit. Anything
// that calls it compiles cleanly and then fails at LINK time with
// "undefined reference to esphome::logger::Logger::level_for" - which is
// exactly how include/rs485_modbus.h's first attempt at a runtime
// log-level check made it all the way to a real device build before
// failing. Leaving it undefined here means this test binary refuses
// to link for the same reason, in seconds instead of after a full
// ESP-IDF build.
class Logger {
 public:
  uint8_t level{ESPHOME_LOG_LEVEL_DEBUG};
  inline uint8_t level_for(const char *tag);
};

extern Logger *global_logger;

}  // namespace logger
}  // namespace esphome
