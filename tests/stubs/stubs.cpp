// Definitions for the few globals the stub headers declare.
#include <cstdarg>
#include "esphome/core/log.h"
#include "esphome/core/hal.h"
#include "esphome/core/application.h"
#include "esphome/components/logger/logger.h"

namespace test_log {
std::vector<std::string> lines;
void record(const char *level, const char *tag, const char *fmt, ...) {
  char buf[512];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  lines.push_back(std::string(level) + " [" + tag + "] " + buf);
}
}  // namespace test_log

namespace esphome {
uint32_t test_millis = 1000;
Application App;
namespace logger {
Logger real_logger;
Logger *global_logger = &real_logger;
}  // namespace logger
}  // namespace esphome
