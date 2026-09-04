#pragma once
#include <cmath>
#include <vector>
namespace esphome {
namespace sensor {
class Sensor {
 public:
  std::vector<float> published;
  float state{NAN};
  bool has_state() const { return this->has_state_; }
  void publish_state(float value) {
    this->state = value;
    this->has_state_ = true;
    this->published.push_back(value);
  }

 private:
  bool has_state_{false};
};
}  // namespace sensor
}  // namespace esphome
