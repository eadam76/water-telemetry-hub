#ifdef USE_ESP32

#include "log_ring_buffer.h"
#include "esphome/core/log.h"

namespace esphome {
namespace log_ring_buffer {

static const char *const TAG = "log_ring_buffer";

void LogRingBuffer::setup() {
  // See logger.h's own add_log_callback() doc comment - this is the
  // documented usage pattern, not a workaround.
  if (logger::global_logger != nullptr) {
    logger::global_logger->add_log_callback(this, &LogRingBuffer::on_log_trampoline_);
  } else {
    ESP_LOGW(TAG, "No logger component found - log download will always be empty");
  }
  // Adds this as one more URL handler on the SAME AsyncWebServer instance
  // the dashboard's own web_server: already runs (global_web_server_base
  // is that component's own extern global, populated as soon as it's
  // constructed - by the time any component's setup() runs, every
  // component has already been constructed, so this is never null here
  // as long as web_server_base is actually configured, which it always
  // is transitively via water-telemetry-hub.yaml's web_server:).
  if (web_server_base::global_web_server_base != nullptr) {
    web_server_base::global_web_server_base->add_handler(this);
  } else {
    ESP_LOGW(TAG, "No web server found - log download endpoint will not be reachable");
  }
}

void LogRingBuffer::dump_config() {
  ESP_LOGCONFIG(TAG, "Log Ring Buffer:");
  ESP_LOGCONFIG(TAG, "  Max size: %u bytes", static_cast<unsigned>(this->max_size_));
}

void LogRingBuffer::on_log_trampoline_(void *self, uint8_t level, const char *tag, const char *message,
                                        size_t message_len) {
  static_cast<LogRingBuffer *>(self)->on_log_(level, tag, message, message_len);
}

void LogRingBuffer::on_log_(uint8_t level, const char *tag, const char *message, size_t message_len) {
  LockGuard lock(this->mutex_);
  this->buffer_.append(message, message_len);
  this->buffer_.push_back('\n');
  // Trim from the front, one full line at a time, until back under
  // budget - a fixed-size RAM ring, not unbounded growth. The explicit
  // flash-wear concern this component exists to avoid doesn't apply to
  // RAM, but unbounded RAM growth would eventually crash the device the
  // same way any real memory leak would, so this still needs a ceiling.
  //
  // The trim is bookkeeping, not copying: this used to erase(0, n) from
  // the front of the string on every single line once the buffer was
  // full, which memmoves the whole remaining ~16 KB each time - on the
  // logging path, which at VERY_VERBOSE ("Debug Log: Modbus") runs for
  // every Modbus transaction. Moving a start_ offset instead makes the
  // common case free; the actual compaction happens once per
  // max_size_/2 bytes of dropped log rather than once per line.
  while (this->buffer_.size() - this->start_ > this->max_size_) {
    size_t newline_pos = this->buffer_.find('\n', this->start_);
    if (newline_pos == std::string::npos) {
      // Shouldn't happen (every append above ends with '\n'), but don't
      // spin forever if it somehow does.
      this->buffer_.clear();
      this->start_ = 0;
      break;
    }
    this->start_ = newline_pos + 1;
  }
  if (this->start_ >= this->max_size_ / 2) {
    this->buffer_.erase(0, this->start_);
    this->start_ = 0;
  }
}

bool LogRingBuffer::canHandle(web_server_idf::AsyncWebServerRequest *request) const {
  if (request->method() != HTTP_GET)
    return false;
  char url_buf[web_server_idf::AsyncWebServerRequest::URL_BUF_SIZE];
  StringRef url = request->url_to(url_buf);
  return url == "/log.txt";
}

void LogRingBuffer::handleRequest(web_server_idf::AsyncWebServerRequest *request) {
  std::string snapshot;
  {
    LockGuard lock(this->mutex_);
    snapshot = this->buffer_.substr(this->start_);
  }
  auto *response = request->beginResponse(200, "text/plain; charset=utf-8", snapshot);
  // Content-Disposition: attachment - the actual "download" part; without
  // it a browser just navigates to/displays the plain text instead of
  // saving it as a file.
  response->addHeader("Content-Disposition", "attachment; filename=\"device-log.txt\"");
  request->send(response);
}

}  // namespace log_ring_buffer
}  // namespace esphome

#endif  // USE_ESP32
