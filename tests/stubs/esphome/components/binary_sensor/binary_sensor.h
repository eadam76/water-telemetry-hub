#pragma once
#include <vector>
namespace esphome {
namespace binary_sensor {
class BinarySensor {
 public:
  bool state{false};
  std::vector<bool> published;
  bool has_state() const { return this->has_state_; }
  void publish_state(bool value) {
    this->state = value;
    this->has_state_ = true;
    this->published.push_back(value);
  }

 private:
  bool has_state_{false};
};
}  // namespace binary_sensor
}  // namespace esphome
