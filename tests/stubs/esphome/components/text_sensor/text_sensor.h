#pragma once
#include <string>
#include <vector>
namespace esphome {
namespace text_sensor {
class TextSensor {
 public:
  std::string state;
  std::vector<std::string> published;
  void publish_state(const std::string &value) {
    this->state = value;
    this->published.push_back(value);
  }
};
}  // namespace text_sensor
}  // namespace esphome
