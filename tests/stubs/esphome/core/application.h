#pragma once
namespace esphome {
struct Application {
  void feed_wdt() {}
};
extern Application App;
}  // namespace esphome
