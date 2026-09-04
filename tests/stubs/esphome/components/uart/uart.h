#pragma once
// A fake UART the tests can preload with a reply frame and inspect
// afterwards - this is what lets the Modbus request/reply path be tested
// end to end (framing, CRC, echo verification, decoding) rather than only
// its individual helpers.
//
// Three delivery modes, and real tests mix them:
//
//  - `replies`: the original mode - one whole reply, handed over the
//    instant the matching request is written, to WHICHEVER address wrote
//    next. Good enough for anything that only cares "what comes back",
//    not "when", "in how many pieces", or "which address": one address
//    at a time is the overwhelming majority of tests below.
//
//  - `replies_by_address`: the same instant delivery, but keyed to the
//    address the OUTGOING request actually names (its first byte) -
//    checked first, before falling back to the flat `replies` queue.
//    Needed the moment a test sweeps more than one address in a single
//    scan: `replies` alone cannot tell "nothing queued for address 42"
//    apart from "address 100's reply, queued earlier, just hasn't been
//    claimed yet" - a real bus scan sweeping 1-247 has dozens of silent
//    addresses between any two answering ones, and a flat FIFO would
//    hand a LATER address's queued reply to an EARLIER, unrelated,
//    genuinely-silent one the moment it wrote first. Per-address queues
//    are what make a real multi-address sweep possible to construct at
//    all.
//
//  - `timed_replies`: one entry per request, each a list of byte chunks
//    with their OWN delay (in ms) from the moment the request went out.
//    A chunk only becomes visible to available()/read_byte()/read_array()
//    once that much virtual time (esphome::test_millis, driven by the
//    stub's own yield()/delay()) has actually passed - so a state machine
//    polled once per tick genuinely has to poll it more than once to see
//    a multi-chunk reply arrive, exactly as it would over a real 9600-
//    baud line. This is what lets a test build a delayed second frame or
//    a reply that trickles in a few bytes at a time, instead of only ever
//    handing a state machine a complete answer on its very first look.
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <vector>

#include "esphome/core/hal.h"

namespace esphome {
namespace uart {

class UARTComponent {
 public:
  struct TimedChunk {
    uint32_t delay_ms;  // from the moment the request that triggers it was written
    std::vector<uint8_t> bytes;
  };

  std::deque<uint8_t> rx;                     // bytes already due and visible to the reader
  std::vector<uint8_t> tx;                    // everything written by the driver
  std::vector<std::vector<uint8_t>> replies;  // legacy: one whole reply, instant on write, address-agnostic
  std::map<uint8_t, std::vector<std::vector<uint8_t>>> replies_by_address;  // instant, per target address
  std::vector<std::vector<TimedChunk>> timed_replies;  // one entry per request, staged delivery

  size_t available() {
    this->release_due_();
    return this->rx.size();
  }

  bool read_byte(uint8_t *out) {
    this->release_due_();
    if (this->rx.empty()) return false;
    *out = this->rx.front();
    this->rx.pop_front();
    return true;
  }

  bool read_array(uint8_t *out, size_t len) {
    this->release_due_();
    if (this->rx.size() < len) return false;
    for (size_t i = 0; i < len; i++) {
      out[i] = this->rx.front();
      this->rx.pop_front();
    }
    return true;
  }

  void write_array(const uint8_t *data, size_t len) {
    this->tx.insert(this->tx.end(), data, data + len);
    // A request implicitly flushes anything scheduled but not yet due
    // from an EARLIER request - a real device stops caring about a
    // question nobody is still asking. Matches flush_rx()'s own effect
    // at the start of every start_request().
    this->pending_.clear();
    if (!this->timed_replies.empty()) {
      uint32_t now = esphome::millis();
      for (auto &chunk : this->timed_replies.front()) {
        this->pending_.push_back({now + chunk.delay_ms, chunk.bytes});
      }
      std::sort(this->pending_.begin(), this->pending_.end(),
                [](const Scheduled &a, const Scheduled &b) { return a.at_ms < b.at_ms; });
      this->timed_replies.erase(this->timed_replies.begin());
      return;
    }
    // Per-address queue takes priority when the request's own target
    // address has one - see replies_by_address's own comment above.
    if (len > 0) {
      auto found = this->replies_by_address.find(data[0]);
      if (found != this->replies_by_address.end() && !found->second.empty()) {
        auto reply = found->second.front();
        found->second.erase(found->second.begin());
        this->rx.insert(this->rx.end(), reply.begin(), reply.end());
        return;
      }
    }
    // Serving the next queued reply on write is what makes the fake
    // behave like a real half-duplex bus: nothing to read until a
    // request has gone out.
    if (!this->replies.empty()) {
      auto reply = this->replies.front();
      this->replies.erase(this->replies.begin());
      this->rx.insert(this->rx.end(), reply.begin(), reply.end());
    }
  }

 private:
  struct Scheduled {
    uint32_t at_ms;
    std::vector<uint8_t> bytes;
  };
  std::deque<Scheduled> pending_;

  void release_due_() {
    while (!this->pending_.empty() && (int32_t) (esphome::millis() - this->pending_.front().at_ms) >= 0) {
      auto &chunk = this->pending_.front();
      this->rx.insert(this->rx.end(), chunk.bytes.begin(), chunk.bytes.end());
      this->pending_.pop_front();
    }
  }
};

}  // namespace uart
}  // namespace esphome
