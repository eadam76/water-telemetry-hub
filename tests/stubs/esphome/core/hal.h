#pragma once
#include <cstdint>
namespace esphome {
// The tests drive time by hand so a timeout is deterministic rather than
// dependent on how fast the machine running them happens to be.
extern uint32_t test_millis;
inline uint32_t millis() { return test_millis; }
inline void yield() { test_millis += 1; }
inline void delay(uint32_t ms) { test_millis += ms; }
}  // namespace esphome
