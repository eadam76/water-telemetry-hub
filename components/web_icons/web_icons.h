#pragma once

// ESP32-only, same as the web_server_idf fork this depends on (see
// web_server_idf.h's own #ifdef USE_ESP32 guard) - this project only ever
// targets ESP32-S3 (water-telemetry-hub.yaml's esp32: block).
#ifdef USE_ESP32

#include "esphome/core/component.h"
#include "esphome/components/web_server_base/web_server_base.h"
#include "esphome/components/web_server_idf/web_server_idf.h"

namespace esphome {
namespace web_icons {

// See this component's own __init__.py for what it serves and why the
// icons are served rather than inlined. Registers one AsyncWebHandler on
// the existing web server in setup() - purely additive, it touches
// nothing the dashboard's own REST/SSE API already does.
class WebIcons : public Component, public web_server_idf::AsyncWebHandler {
 public:
  void set_favicon_svg(const uint8_t *data, size_t size) {
    this->favicon_svg_ = data;
    this->favicon_svg_size_ = size;
  }
  void set_apple_touch_icon(const uint8_t *data, size_t size) {
    this->apple_touch_icon_ = data;
    this->apple_touch_icon_size_ = size;
  }

  void setup() override;
  float get_setup_priority() const override { return setup_priority::LATE; }
  void dump_config() override;

  // web_server_idf::AsyncWebHandler
  bool canHandle(web_server_idf::AsyncWebServerRequest *request) const override;  // NOLINT(readability-identifier-naming)
  void handleRequest(web_server_idf::AsyncWebServerRequest *request) override;    // NOLINT(readability-identifier-naming)

 protected:
  // Both point at PROGMEM arrays generated at build time - never freed,
  // never copied.
  const uint8_t *favicon_svg_{nullptr};
  size_t favicon_svg_size_{0};
  const uint8_t *apple_touch_icon_{nullptr};
  size_t apple_touch_icon_size_{0};
};

}  // namespace web_icons
}  // namespace esphome

#endif  // USE_ESP32
