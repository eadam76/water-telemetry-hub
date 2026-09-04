#pragma once
// Minimal stand-in for ESPHome's logging macros, for the host-side tests.
// Log output is captured rather than printed so a test can assert on
// warnings (e.g. "the write echoed something else back").
#include <string>
#include <vector>
#include <cstdio>

#define ESPHOME_LOG_LEVEL_NONE 0
#define ESPHOME_LOG_LEVEL_ERROR 1
#define ESPHOME_LOG_LEVEL_WARN 2
#define ESPHOME_LOG_LEVEL_INFO 3
#define ESPHOME_LOG_LEVEL_CONFIG 4
#define ESPHOME_LOG_LEVEL_DEBUG 5
#define ESPHOME_LOG_LEVEL_VERBOSE 6
#define ESPHOME_LOG_LEVEL_VERY_VERBOSE 7

namespace test_log {
extern std::vector<std::string> lines;
void record(const char *level, const char *tag, const char *fmt, ...);
}  // namespace test_log

#define ESP_LOGE(tag, ...) ::test_log::record("E", tag, __VA_ARGS__)
#define ESP_LOGW(tag, ...) ::test_log::record("W", tag, __VA_ARGS__)
#define ESP_LOGI(tag, ...) ::test_log::record("I", tag, __VA_ARGS__)
#define ESP_LOGD(tag, ...) ::test_log::record("D", tag, __VA_ARGS__)
#define ESP_LOGV(tag, ...) ::test_log::record("V", tag, __VA_ARGS__)
#define ESP_LOGVV(tag, ...) ::test_log::record("VV", tag, __VA_ARGS__)
#define ESP_LOGCONFIG(tag, ...) ::test_log::record("C", tag, __VA_ARGS__)
