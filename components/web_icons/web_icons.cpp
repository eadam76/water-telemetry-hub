#ifdef USE_ESP32

#include "web_icons.h"
#include "esphome/core/log.h"

namespace esphome {
namespace web_icons {

static const char *const TAG = "web_icons";

static const char *const FAVICON_PATH = "/favicon.svg";
static const char *const TOUCH_ICON_PATH = "/apple-touch-icon.png";
// Older iOS versions ask for this name first; same bytes.
static const char *const TOUCH_ICON_PRECOMPOSED_PATH = "/apple-touch-icon-precomposed.png";

void WebIcons::setup() {
  // Same reasoning as log_ring_buffer's setup(): global_web_server_base is
  // populated as soon as the web_server_base component is constructed,
  // which is before any component's setup() runs.
  if (web_server_base::global_web_server_base != nullptr) {
    web_server_base::global_web_server_base->add_handler(this);
  } else {
    ESP_LOGW(TAG, "No web server found - icons will not be reachable");
  }
}

void WebIcons::dump_config() {
  ESP_LOGCONFIG(TAG, "Web Icons:");
  ESP_LOGCONFIG(TAG, "  %s: %u bytes", FAVICON_PATH, static_cast<unsigned>(this->favicon_svg_size_));
  ESP_LOGCONFIG(TAG, "  %s: %u bytes", TOUCH_ICON_PATH, static_cast<unsigned>(this->apple_touch_icon_size_));
}

bool WebIcons::canHandle(web_server_idf::AsyncWebServerRequest *request) const {
  if (request->method() != HTTP_GET)
    return false;
  char url_buf[web_server_idf::AsyncWebServerRequest::URL_BUF_SIZE];
  StringRef url = request->url_to(url_buf);
  return url == FAVICON_PATH || url == TOUCH_ICON_PATH || url == TOUCH_ICON_PRECOMPOSED_PATH;
}

void WebIcons::handleRequest(web_server_idf::AsyncWebServerRequest *request) {
  char url_buf[web_server_idf::AsyncWebServerRequest::URL_BUF_SIZE];
  StringRef url = request->url_to(url_buf);
  const uint8_t *data = this->apple_touch_icon_;
  size_t size = this->apple_touch_icon_size_;
  const char *content_type = "image/png";
  if (url == FAVICON_PATH) {
    data = this->favicon_svg_;
    size = this->favicon_svg_size_;
    content_type = "image/svg+xml";
  }
  auto *response = request->beginResponse(200, content_type, data, size);
  // The icons only change with a firmware update, and a browser that
  // re-fetched them on every page load would spend one of this server's
  // few sockets on 18 KB it already has (see the max_open_sockets note in
  // components/web_server_idf/web_server_idf.cpp). A week is long enough
  // to matter and short enough that a new icon still shows up on its own.
  response->addHeader("Cache-Control", "public, max-age=604800");
  request->send(response);
}

}  // namespace web_icons
}  // namespace esphome

#endif  // USE_ESP32
