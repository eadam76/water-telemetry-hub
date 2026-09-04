#pragma once

// ESP32-only, same as the web_server_idf fork this depends on (see
// web_server_idf.h's own #ifdef USE_ESP32 guard) - this project only ever
// targets ESP32-S3 (water-telemetry-hub.yaml's esp32: block), so no other
// platform branch is needed here.
#ifdef USE_ESP32

#include "esphome/core/component.h"
#include "esphome/core/helpers.h"
#include "esphome/components/logger/logger.h"
#include "esphome/components/web_server_base/web_server_base.h"
#include "esphome/components/web_server_idf/web_server_idf.h"

#include <string>

namespace esphome {
namespace log_ring_buffer {

// See this component's own __init__.py for the full "why RAM, not flash"
// reasoning. Registers two things in setup(): a logger log-callback
// (appends every incoming line) and an AsyncWebHandler on the existing web
// server (serves the buffer as a GET /log.txt download) - both purely
// additive, neither touches anything the dashboard's own REST/SSE API
// already does.
class LogRingBuffer : public Component, public web_server_idf::AsyncWebHandler {
 public:
  void set_max_size(size_t max_size) { this->max_size_ = max_size; }

  void setup() override;
  float get_setup_priority() const override { return setup_priority::LATE; }
  void dump_config() override;

  // web_server_idf::AsyncWebHandler
  bool canHandle(web_server_idf::AsyncWebServerRequest *request) const override;  // NOLINT(readability-identifier-naming)
  void handleRequest(web_server_idf::AsyncWebServerRequest *request) override;    // NOLINT(readability-identifier-naming)

 protected:
  // Raw C-style callback required by Logger::add_log_callback() (see that
  // method's own doc comment in logger.h for exactly this trampoline
  // pattern) - dispatches back into the instance method below.
  static void on_log_trampoline_(void *self, uint8_t level, const char *tag, const char *message,
                                  size_t message_len);
  void on_log_(uint8_t level, const char *tag, const char *message, size_t message_len);

  // Guards buffer_ - the logger doc comment for add_log_callback notes
  // logging itself is safe across tasks without locks internally, but
  // that's about the logger's own dispatch, not about two tasks
  // concurrently appending into OUR std::string - genuinely possible on a
  // dual-core ESP32 (e.g. a Wi-Fi-stack log line landing while the main
  // loop is also logging), so this buffer needs its own lock.
  Mutex mutex_;
  std::string buffer_;
  // Index of the oldest still-live byte in buffer_ - everything before it
  // has been trimmed but not yet physically removed (see on_log_() for
  // why the removal is deferred).
  size_t start_{0};
  size_t max_size_{16000};
};

}  // namespace log_ring_buffer
}  // namespace esphome

#endif  // USE_ESP32
