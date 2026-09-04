#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdio>
namespace esphome {
constexpr size_t format_hex_pretty_size(size_t byte_count) { return byte_count * 3; }
inline char *format_hex_pretty_to(char *buffer, size_t buffer_size, const uint8_t *data, size_t length,
                                  char separator = ':') {
  size_t pos = 0;
  for (size_t i = 0; i < length && pos + 3 < buffer_size; i++) {
    if (i > 0 && separator != '\0') buffer[pos++] = separator;
    pos += snprintf(buffer + pos, buffer_size - pos, "%02X", data[i]);
  }
  buffer[pos < buffer_size ? pos : buffer_size - 1] = '\0';
  return buffer;
}
template<size_t N>
inline char *format_hex_pretty_to(char (&buffer)[N], const uint8_t *data, size_t length, char separator = ':') {
  return format_hex_pretty_to(buffer, N, data, length, separator);
}
}  // namespace esphome
