#pragma once


#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "esphome/core/alloc_helpers.h"
#include "esphome/core/application.h"
#include "esphome/core/hal.h"
#include "esphome/core/log.h"
#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/text_sensor/text_sensor.h"
#include "esphome/components/uart/uart.h"

namespace rs485_modbus {

using esphome::uart::UARTComponent;

// Everything in this file logs under this one tag - "Debug Log: Modbus"
// (water-telemetry-hub.yaml's `switch:` section) flips it to VERY_VERBOSE at
// runtime via `logger.set_level`, off by default (see the `logger:`
// block's own comment for why the compile-time ceiling has to be raised
// separately from the runtime default for that switch to have anything
// to turn on).
static const char *const TAG = "modbus";

// Largest register block anything here reads (FLOW_BLOCK_REGISTERS
// below), and the frame sizes that follow from it. Everything in this
// file works out of fixed-size stack buffers sized from these - no
// per-transaction heap allocation on the polling path, which runs a few
// times a second for the device's entire uptime.
static constexpr uint16_t MAX_REGISTERS = 20;
static constexpr size_t MAX_REPLY_LEN = 5 + 2 * MAX_REGISTERS;  // address, function, byte count, payload, CRC16
static constexpr size_t MAX_REQUEST_LEN = 8;                     // 6-byte PDU + CRC16

// --- CRC16 (Modbus RTU, poly 0xA001, init 0xFFFF) --------------------
// Cross-checked against 4 worked examples straight from the QDW90A
// manufacturer's own Modbus protocol PDF - all matched exactly.
inline uint16_t crc16(const uint8_t *data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t pos = 0; pos < len; pos++) {
    crc ^= data[pos];
    for (int i = 0; i < 8; i++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

// --- Wire-level tracing ------------------------------------------------
// ESP_LOGVV is a plain function call under the macro, so its arguments
// are evaluated whether or not the "modbus" tag is currently at
// VERY_VERBOSE - which meant every single transaction formatted a hex
// dump of its own frames (and, before this, heap-allocated a std::string
// for each) even with "Debug Log: Modbus" switched off, which is its
// normal state. Every trace site below is guarded on this instead, and
// formats into a caller-owned stack buffer.
//
// A flag of our own rather than asking the logger: Logger::level_for()
// looks like the obvious answer and compiles fine, but it's declared
// `inline` with no visible definition, so calling it from a lambda in
// main.cpp only fails at link time ("undefined reference to
// esphome::logger::Logger::level_for"). The "Debug Log: Modbus" switch
// (water-telemetry-hub.yaml) sets this flag alongside its own
// logger.set_level, so the two can't drift apart.
inline bool &trace_enabled_flag() {
  static bool enabled = false;
  return enabled;
}

inline bool trace_enabled() { return trace_enabled_flag(); }

// Buffer type every trace site declares before calling hex_dump() - big
// enough for the longest frame this file can produce.
using TraceBuffer = char[esphome::format_hex_pretty_size(MAX_REPLY_LEN)];

inline const char *hex_dump(TraceBuffer &buffer, const uint8_t *data, size_t len) {
  return esphome::format_hex_pretty_to(buffer, data, len);
}

// --- Low-level transaction plumbing -----------------------------------

inline void flush_rx(UARTComponent *bus) {
  uint8_t discard;
  while (bus->available() > 0) {
    if (!bus->read_byte(&discard)) break;
  }
}

// What became of one request. The three failure cases are deliberately
// distinct, because they mean genuinely different things to a slot's
// Online/Collision diagnostics: nothing answered at all, something
// answered but the frame didn't decode (bus noise, or two devices
// replying over each other), or the device answered properly with a
// refusal - which still proves it is there and listening.
// COLLISION is deliberately narrower than "the frame was corrupt": it is
// only the one corruption pattern that actually implies two devices
// answered at once - see validate_() for why the distinction matters and
// what went wrong when BAD_FRAME carried both meanings.
enum class TxResult : uint8_t { NONE, OK, TIMEOUT, BAD_FRAME, EXCEPTION, COLLISION };

// The same outcome, in the vocabulary every caller that has to REASON
// about how many devices answered actually needs - probing an unknown
// address, fingerprinting, a scan's confirmation reads, and the write
// safety checks before Add/an address change. TxResult stays the wire-
// level record of what one transaction did; AddressObservation is what
// that means for "is this address safe to trust or to write to".
//
// Five outcomes, not two or three, because folding them together made
// this fragile: a device that refused a register (EXCEPTION) still
// proves it is there, alone; a header that matches ours with a failed
// CRC (PROVEN_COLLISION) is a near-certainty, not a guess (see
// Transaction::validate_ for the two ways that shape arises and why each
// passes only about once in 65536 by chance); and bytes that arrived but
// formed no valid frame at all (DAMAGED_ACTIVITY) are neither silence
// nor proof by themselves - two identical devices on one address can
// answer in near-perfect lockstep (a valid frame, chance alignment) or
// half a bit apart (garbage that proves nothing alone). What turns
// DAMAGED_ACTIVITY into a verdict is correlation across more than one
// observation of the SAME address - AddressInspector below is where
// that happens; nothing here calls a single noisy frame on an untested
// address a proven collision.
enum class AddressObservation : uint8_t {
  SILENCE,             // nothing at all within the timeout
  VALID_RESPONSE,      // a complete, correctly-addressed 0x03 reply
  EXCEPTION_RESPONSE,  // a complete, correctly-addressed Modbus exception - the device is there
  DAMAGED_ACTIVITY,    // bytes arrived, no valid frame resulted, and the header does not prove it was ours
  PROVEN_COLLISION,    // the frame shape (or a CRC-repaired header) matches our own request - certain
};

// One Modbus RTU read, as a state machine rather than a blocking wait.
//
// A blocking `while (available() < n)` loop for the whole reply costs up
// to ~40 ms for a 12-register read at 9600 baud, and the full timeout for
// a device that never answers. That matters because ESPHome's SSE stream
// is pumped from the main loop (AsyncEventSource::loop(), our own
// components/web_server_idf fork) and advances exactly ONE entity per
// loop iteration - every millisecond spent waiting on the bus is a
// millisecond the dashboard isn't being fed, which put polling several
// devices several times a second out of reach.
//
// Driven from an interval that ticks every few milliseconds (see
// water-telemetry-hub.yaml), the main loop now only ever blocks for the
// request transmission itself (~8 ms - ESPHome holds the RS485 driver-
// enable pin across the write and waits for TX to drain, which we can't
// avoid from here). Everything after that is "have some bytes arrived
// yet?", which costs nothing.
//
// The synchronous helpers further down (bus scan, address change,
// battery read) still block, deliberately: they run on an explicit
// button press, never on a schedule, and they are built on this same
// state machine rather than a second implementation of the protocol.
class Transaction {
 public:
  bool idle() const { return this->state_ == State::IDLE; }
  bool busy() const { return this->state_ == State::WAIT_HEADER || this->state_ == State::WAIT_BODY; }
  bool done() const { return this->state_ == State::DONE; }

  uint8_t address() const { return this->address_; }
  uint16_t register_count() const { return this->count_; }

  // Sends a request PDU (address + function + data, no CRC - that is
  // appended here). Returns false if a transaction is already in flight
  // or the request is malformed - never queues.
  bool start_request(UARTComponent *bus, const uint8_t *pdu, size_t pdu_len, size_t expected_len,
                     uint32_t timeout_ms) {
    if (!this->idle()) return false;
    if (pdu_len < 2 || pdu_len + 2 > MAX_REQUEST_LEN) return false;
    if (expected_len < 5 || expected_len > MAX_REPLY_LEN) return false;
    flush_rx(bus);
    uint8_t frame[MAX_REQUEST_LEN];
    std::memcpy(frame, pdu, pdu_len);
    uint16_t crc = crc16(frame, pdu_len);
    frame[pdu_len] = static_cast<uint8_t>(crc & 0xFF);             // CRC low byte first (Modbus RTU wire order)
    frame[pdu_len + 1] = static_cast<uint8_t>((crc >> 8) & 0xFF);  // CRC high byte
    size_t frame_len = pdu_len + 2;
    TraceBuffer trace;
    if (trace_enabled()) ESP_LOGVV(TAG, "-> %s", hex_dump(trace, frame, frame_len));
    // The one place the main loop still stops: ESPHome holds the RS485
    // driver-enable pin across this write and waits for the transmitter
    // to drain, so an 8-byte request costs ~8 ms at 9600 baud. Nothing
    // reachable from here can avoid that; everything after it is
    // non-blocking.
    bus->write_array(frame, frame_len);
    this->address_ = pdu[0];
    this->function_ = pdu[1];
    this->count_ = 0;
    this->expected_len_ = expected_len;
    this->total_len_ = expected_len;
    this->received_ = 0;
    this->result_ = TxResult::NONE;
    this->timeout_ms_ = timeout_ms;
    this->phase_start_ms_ = esphome::millis();
    this->state_ = State::WAIT_HEADER;
    return true;
  }

  // 0x03 Read Holding Registers.
  bool start_read(UARTComponent *bus, uint8_t address, uint16_t start_reg, uint16_t count, uint32_t timeout_ms) {
    if (count == 0 || count > MAX_REGISTERS) return false;
    const uint8_t pdu[6] = {address,
                            0x03,
                            static_cast<uint8_t>(start_reg >> 8),
                            static_cast<uint8_t>(start_reg & 0xFF),
                            static_cast<uint8_t>(count >> 8),
                            static_cast<uint8_t>(count & 0xFF)};
    if (!this->start_request(bus, pdu, sizeof(pdu), 5 + 2 * static_cast<size_t>(count), timeout_ms)) return false;
    this->count_ = count;
    return true;
  }

  // Call every tick. Reads whatever has arrived so far and finishes the
  // transaction as soon as the frame is complete (or the timeout runs
  // out) - never waits.
  void poll(UARTComponent *bus) {
    if (!this->busy()) return;
    if (this->state_ == State::WAIT_HEADER) {
      // The shortest possible reply (an exception) is 5 bytes - the
      // first 3 (address, function, byte-count-or-exception-code) are
      // what decides how much more there is to read.
      if (bus->available() < 3) {
        if (esphome::millis() - this->phase_start_ms_ >= this->timeout_ms_) {
          if (trace_enabled())
            ESP_LOGVV(TAG, "<- address %d: no reply within %ums", this->address_,
                      static_cast<unsigned int>(this->timeout_ms_));
          this->finish_(TxResult::TIMEOUT);
        }
        return;
      }
      if (!bus->read_array(this->reply_, 3)) {
        if (trace_enabled()) ESP_LOGVV(TAG, "<- address %d: UART read error on the header bytes", this->address_);
        this->finish_(TxResult::BAD_FRAME);
        return;
      }
      this->received_ = 3;
      bool is_exception = (this->reply_[1] & 0x80) != 0;
      this->total_len_ = is_exception ? 5 : this->expected_len_;
      if (this->total_len_ > sizeof(this->reply_)) {
        this->finish_(TxResult::BAD_FRAME);
        return;
      }
      // The rest of the frame gets its own full timeout window: the
      // device has already proven it is answering, so what matters from
      // here is how long the remaining bytes take to arrive.
      this->phase_start_ms_ = esphome::millis();
      this->state_ = State::WAIT_BODY;
    }
    // WAIT_BODY - take whatever is available, however little.
    size_t remaining = this->total_len_ - this->received_;
    size_t available = bus->available();
    size_t chunk = available < remaining ? available : remaining;
    if (chunk > 0) {
      if (!bus->read_array(this->reply_ + this->received_, chunk)) {
        if (trace_enabled()) ESP_LOGVV(TAG, "<- address %d: UART read error on the reply body", this->address_);
        this->finish_(TxResult::BAD_FRAME);
        return;
      }
      this->received_ += chunk;
    }
    if (this->received_ == this->total_len_) {
      this->validate_();
      return;
    }
    if (esphome::millis() - this->phase_start_ms_ >= this->timeout_ms_) {
      TraceBuffer trace;
      if (trace_enabled())
        ESP_LOGVV(TAG, "<- address %d: reply started (%s...) but the rest never arrived", this->address_,
                  hex_dump(trace, this->reply_, this->received_));
      this->finish_(TxResult::BAD_FRAME);
    }
  }

  // The validated reply frame, for callers that need the raw bytes (the
  // 0x06 write's echo check). Only meaningful while done().
  const uint8_t *reply() const { return this->reply_; }
  size_t reply_len() const { return this->received_; }

  // Bytes came back but no valid frame did: a header and then a damaged
  // or unfinished body. Distinct from silence (TIMEOUT, nothing at all)
  // and from a collision the frame shape could prove - this is what two
  // devices sharing an address look like when their replies land on top
  // of each other and the CRC goes too. Only meaningful while done().
  bool damaged() const { return this->result_ == TxResult::BAD_FRAME && this->received_ >= 3; }

  // The classification every caller outside this class should reason in
  // terms of - see AddressObservation's own comment. Callable any time
  // after done() and before take() (which resets the transaction), same
  // as damaged().
  AddressObservation observation() const {
    switch (this->result_) {
      case TxResult::OK:
        return AddressObservation::VALID_RESPONSE;
      case TxResult::EXCEPTION:
        return AddressObservation::EXCEPTION_RESPONSE;
      case TxResult::COLLISION:
        return AddressObservation::PROVEN_COLLISION;
      case TxResult::BAD_FRAME:
        return this->damaged() ? AddressObservation::DAMAGED_ACTIVITY : AddressObservation::SILENCE;
      case TxResult::TIMEOUT:
      case TxResult::NONE:
      default:
        return AddressObservation::SILENCE;
    }
  }

  // Reads out the outcome and frees the transaction for the next
  // request. Registers are only written for TxResult::OK.
  TxResult take(uint16_t *out, size_t out_cap, size_t *count_out) {
    if (count_out != nullptr) *count_out = 0;
    TxResult result = this->result_;
    if (result == TxResult::OK && out != nullptr) {
      if (this->count_ > out_cap) {
        result = TxResult::BAD_FRAME;
      } else {
        for (uint16_t i = 0; i < this->count_; i++) {
          out[i] = static_cast<uint16_t>((this->reply_[3 + i * 2] << 8) | this->reply_[4 + i * 2]);
        }
        if (count_out != nullptr) *count_out = this->count_;
      }
    }
    this->reset();
    return result;
  }

  // Throws away a finished transaction nobody claimed.
  void reset() {
    this->state_ = State::IDLE;
    this->result_ = TxResult::NONE;
    this->received_ = 0;
  }

 private:
  enum class State : uint8_t { IDLE, WAIT_HEADER, WAIT_BODY, DONE };

  void finish_(TxResult result) {
    this->result_ = result;
    this->state_ = State::DONE;
  }

  void validate_() {
    uint16_t got_crc =
        static_cast<uint16_t>(this->reply_[this->total_len_ - 2] | (this->reply_[this->total_len_ - 1] << 8));
    uint16_t want_crc = crc16(this->reply_, this->total_len_ - 2);
    TraceBuffer trace;
    if (got_crc != want_crc) {
      // A failed CRC says the frame is damaged, not why - and the two
      // reasons need opposite answers on the dashboard.
      //
      // Two devices sharing an address answer the same request with
      // byte-identical headers (same address, same function, same byte
      // count) and differ only in the register values, so what comes back
      // is a frame of exactly the shape we asked for whose CRC fails.
      // That shape is the evidence of a collision.
      //
      // A broken or floating conductor produces something entirely
      // different: whatever the receiver picks out of the noise, which
      // matches our own header only by coincidence. Treating every
      // corrupt frame as a collision made a wiring fault look like an
      // address clash - a disconnected line showed "Collision?" where it
      // should have shown "Lost", pointing at the wrong fault entirely.
      //
      // Checking all three header fields (not just the address) is what
      // makes this hold up on a noisy line: a floating line delivers a
      // frame per poll, so a one-byte test would land on our address by
      // chance every few minutes and light the badge anyway.
      bool is_exception = (this->reply_[1] & 0x80) != 0;
      bool shaped_like_our_answer = this->reply_[0] == this->address_ &&
                                    (this->reply_[1] & 0x7F) == this->function_ &&
                                    (is_exception || this->function_ != 0x03 || this->reply_[2] == 2 * this->count_);
      // The other way two identical devices show up: their replies land
      // a fraction of a bit apart and the receiver sees the AND of the
      // two, which chews up the first bytes and misses the header test
      // above, reading as "bus noise". But the tail of such a frame is
      // often intact, CRC included, and that CRC is a fingerprint: put
      // the header we asked for back in place of the damaged one and, if
      // the CRC now checks, this WAS our reply. Noise passes that test
      // one time in 65536.
      bool our_answer_with_damaged_header = false;
      if (!shaped_like_our_answer && !is_exception && this->function_ == 0x03) {
        uint8_t repaired[MAX_REPLY_LEN];
        std::memcpy(repaired, this->reply_, this->total_len_);
        repaired[0] = this->address_;
        repaired[1] = this->function_;
        repaired[2] = static_cast<uint8_t>(2 * this->count_);
        our_answer_with_damaged_header = crc16(repaired, this->total_len_ - 2) == got_crc;
      }
      bool collision = shaped_like_our_answer || our_answer_with_damaged_header;
      if (trace_enabled())
        ESP_LOGVV(TAG, "<- %s: CRC mismatch (got %04X, wanted %04X) - %s",
                  hex_dump(trace, this->reply_, this->total_len_), got_crc, want_crc,
                  shaped_like_our_answer          ? "our own reply, damaged: likely a collision"
                  : our_answer_with_damaged_header ? "our own reply with a damaged header (CRC checks once repaired): collision"
                                                   : "bus noise or bad wiring");
      this->finish_(collision ? TxResult::COLLISION : TxResult::BAD_FRAME);
      return;
    }
    if (this->reply_[0] != this->address_) {
      // reply from a different address - bus noise/collision, ignore
      if (trace_enabled())
        ESP_LOGVV(TAG, "<- %s: address in reply doesn't match request (asked %d) - ignored",
                  hex_dump(trace, this->reply_, this->total_len_), this->address_);
      this->finish_(TxResult::BAD_FRAME);
      return;
    }
    if (trace_enabled()) ESP_LOGVV(TAG, "<- %s", hex_dump(trace, this->reply_, this->total_len_));
    if ((this->reply_[1] & 0x80) != 0) {
      // A proper exception frame: this register block isn't readable,
      // but the device itself answered.
      this->finish_(TxResult::EXCEPTION);
      return;
    }
    if (this->reply_[1] != this->function_) {
      this->finish_(TxResult::BAD_FRAME);
      return;
    }
    // 0x03 additionally states how many payload bytes follow - if that
    // disagrees with what we asked for, the frame isn't the answer to
    // our question however well-formed it looks.
    if (this->function_ == 0x03 && this->reply_[2] != 2 * this->count_) {
      this->finish_(TxResult::BAD_FRAME);
      return;
    }
    this->finish_(TxResult::OK);
  }

  State state_{State::IDLE};
  TxResult result_{TxResult::NONE};
  uint8_t address_{0};
  uint8_t function_{0};
  uint16_t count_{0};
  size_t expected_len_{0};
  size_t total_len_{0};
  size_t received_{0};
  uint32_t timeout_ms_{0};
  uint32_t phase_start_ms_{0};
  uint8_t reply_[MAX_REPLY_LEN]{};
};

// The one transaction the periodic poll uses. Single instance because
// the bus is a single shared resource: whoever holds this holds the bus,
// and the scheduler in water-telemetry-hub.yaml is the only thing that
// starts one.
inline Transaction &poll_transaction() {
  static Transaction transaction;
  return transaction;
}

// --- Public operations --------------------------------------------------

// Hands the bus over from the background poll to a blocking one-shot
// operation.
//
// The two cannot interleave mid-call - both run on the main loop, and
// esphome::yield() switches FreeRTOS tasks without re-entering it - but
// they can collide at the boundary: a button pressed while the scheduler
// has a request out and is waiting for the reply. Without this, the
// one-shot's own flush_rx() would throw away that pending reply, put a
// second request on the wire before the first was answered, and then
// read the WRONG reply back - a 12-register poll response arriving where
// an 8-byte write echo was expected, silently corrupting an address
// change or a battery-voltage read.
//
// So: let the in-flight poll finish (or time out) first, then discard
// it. Its result is dropped rather than delivered - one skipped reading,
// a third of a second, against a corrupted bus. The scheduler notices
// the transaction went idle without it having consumed a result and
// clears its owner (see water-telemetry-hub.yaml).
inline void drain_poll_transaction(UARTComponent *bus) {
  auto &transaction = poll_transaction();
  while (transaction.busy()) {
    esphome::App.feed_wdt();
    esphome::yield();
    transaction.poll(bus);
  }
  transaction.reset();
}

// Blocking read, for the one-shot operations (bus scan, address change,
// battery voltage) that run on an explicit button press. Built on the
// same Transaction as the periodic poll, so there is exactly one
// implementation of the protocol to get right.
// How long to keep listening after a reply that completed, before
// accepting that only one device answered. One frame at 9600 baud is
// about 1 ms per byte, so this covers a second device answering a whole
// frame behind the first.
static constexpr uint32_t SECOND_REPLY_WINDOW_MS = 25;

// Anything arriving after we already have a complete answer came from
// somewhere else - nothing should be talking once the device we asked
// has finished. Consumes whatever turned up, so it cannot be mistaken
// for the next request's reply.
// How much has to arrive before it counts as a second REPLY rather than
// as noise. The shortest Modbus reply that exists is 5 bytes (an
// exception: address, function, code, CRC16), so a byte or two is not a
// device answering - it is an idle line.
//
// This threshold is the whole difference between a working fingerprint
// and a useless one. An RS485 line that is idle and not firmly biased
// floats, and the receiver turns that into framing garbage. With "any
// byte at all" as the test, a single stray byte made every fingerprint
// read report contention - identify() called a perfectly ordinary single
// device a collision, so the scan reported an address clash instead of a
// device type.
static constexpr size_t SECOND_REPLY_MIN_BYTES = 4;

inline bool second_reply_follows(UARTComponent *bus) {
  uint32_t listen_until = esphome::millis() + SECOND_REPLY_WINDOW_MS;
  while (bus->available() < SECOND_REPLY_MIN_BYTES && (int32_t) (esphome::millis() - listen_until) < 0) {
    esphome::App.feed_wdt();
    esphome::yield();
  }
  bool second_reply = bus->available() >= SECOND_REPLY_MIN_BYTES;
  // Whatever turned up goes either way - a real second frame is not ours
  // to read, and idle noise should not be left for the next request.
  flush_rx(bus);
  return second_reply;
}

inline bool read_holding_registers(UARTComponent *bus, uint8_t address, uint16_t start_reg, uint16_t count,
                                    uint16_t *out, size_t out_cap, uint32_t timeout_ms = 200,
                                    bool *collision = nullptr, bool *device_responded = nullptr,
                                    bool *damaged = nullptr) {
  if (collision) *collision = false;
  if (device_responded) *device_responded = false;
  if (damaged) *damaged = false;
  if (count == 0 || count > MAX_REGISTERS || count > out_cap) return false;
  drain_poll_transaction(bus);
  Transaction transaction;
  if (!transaction.start_read(bus, address, start_reg, count, timeout_ms)) return false;
  while (transaction.busy()) {
    esphome::App.feed_wdt();
    esphome::yield();
    transaction.poll(bus);
  }
  // Bytes without a frame - see Transaction::damaged(). Read before
  // take() resets the transaction.
  if (damaged) *damaged = transaction.damaged();
  size_t received = 0;
  TxResult result = transaction.take(out, out_cap, &received);
  // Two kinds of evidence that more than one device answered.
  //
  // COLLISION is our own reply come back damaged - something talked over
  // it. BAD_FRAME deliberately does NOT count: that is the catch-all for
  // noise, truncated frames and bad wiring, none of which say anything
  // about how many devices share an address.
  //
  // The second kind is bytes still arriving after a reply that COMPLETED
  // - including a completed exception, which is the case that matters
  // for the identity fingerprints: asked for a register only one of two
  // devices implements, the other one refuses in five bytes while the
  // first is still sending a longer data frame. Accepting the short
  // refusal and moving on would leave the rest of the real answer in the
  // buffer for the next request's flush_rx() to throw away - discarding
  // the clearest evidence there is that two devices are on this address.
  bool contended = (result == TxResult::COLLISION);
  if (!contended && (result == TxResult::OK || result == TxResult::EXCEPTION)) {
    contended = second_reply_follows(bus);
    if (contended) ESP_LOGD(TAG, "address %d: a second reply followed the first", address);
  }
  if (collision) *collision = contended;
  if (device_responded) *device_responded = (result == TxResult::OK || result == TxResult::EXCEPTION);
  return result == TxResult::OK && received == count;
}

// Blocking 0x06 Write Single Register - same reasoning as
// read_holding_registers() above: only ever reached from a button press
// (address change, calibration), never from the periodic poll.
//
// Only H:0 (address), H:1 (baud), H:12 (zero offset), H:37 (parity),
// plus the H:15/H:16 command registers are actually writable on the
// QDW90A; everything else replies with an exception (surfaced here
// simply as `false`, same as any other failure - see
// project-docs/docs/hardware/qdw90a-modbus-reference.md's register table
// for which is which).
inline bool write_single_register(UARTComponent *bus, uint8_t address, uint16_t reg, uint16_t value,
                                   uint32_t timeout_ms = 200) {
  const uint8_t pdu[6] = {address,
                          0x06,
                          static_cast<uint8_t>(reg >> 8),
                          static_cast<uint8_t>(reg & 0xFF),
                          static_cast<uint8_t>(value >> 8),
                          static_cast<uint8_t>(value & 0xFF)};
  drain_poll_transaction(bus);
  Transaction transaction;
  if (!transaction.start_request(bus, pdu, sizeof(pdu), 8, timeout_ms)) return false;
  while (transaction.busy()) {
    esphome::App.feed_wdt();
    esphome::yield();
    transaction.poll(bus);
  }
  // A successful write echoes the request exactly (function 0x06,
  // register+value unchanged) - always 8 bytes. Verifying only the
  // function code let an echo naming a DIFFERENT register or value pass
  // as success. Transaction already checks CRC and that the reply came
  // from the address we asked; the remaining four bytes are checked here.
  bool echoed = transaction.done() && transaction.reply_len() == 8 && std::memcmp(transaction.reply(), pdu, 6) == 0;
  TxResult result = transaction.take(nullptr, 0, nullptr);
  if (result != TxResult::OK) return false;
  if (!echoed) {
    ESP_LOGW(TAG, "address %d: 0x06 write to register %u echoed something else back - treating as failed", address,
             static_cast<unsigned int>(reg));
    return false;
  }
  return true;
}

// --- Device identification (read-only) -----------------------------------
// Which instrument is actually at an address, established by reading
// registers whose contents are known in advance - never by writing
// anything.
enum class DeviceKind : uint8_t { UNKNOWN, PRESSURE, FLOW };

inline const char *device_kind_name(DeviceKind kind) {
  switch (kind) {
    case DeviceKind::PRESSURE:
      return "Pressure";
    case DeviceKind::FLOW:
      return "Flow";
    default:
      return "";
  }
}

inline float decode_float_low_word_first(uint16_t low, uint16_t high);

// T3-1-2-H: the manufacturer's own communication self-test register pair
// (document 0361-0362) is documented to read back exactly 361.0 - it's
// what settled the word-order question for every 32-bit value this
// device reports (see decode_float_low_word_first()). A fixed constant
// at a fixed address is the ideal fingerprint: nothing else on this bus
// answers it with 361.
//
// Deliberately NOT the manufacturer ID / ESN registers (document
// 1527-1530) that would be the textbook choice: those were found
// consistently unreadable on this unit, which is why they were dropped
// from the device-info panel too (see the Battery Voltage sensor's note
// in packages/pressure_sensor.yaml).
static constexpr uint16_t FLOW_SELFTEST_REG = 360;   // document register "0361"
static constexpr float FLOW_SELFTEST_VALUE = 361.0f;

// QDW90A: H:0-H:3 are its address, baud code, unit code and decimal
// count - four fixed configuration registers in one block, of which two
// are checkable against something known (the address we just asked, and
// the bar unit code 3 this project's sensors are fixed at). See
// project-docs/docs/hardware/qdw90a-modbus-reference.md.
static constexpr uint16_t PRESSURE_IDENTITY_REG = 0;
static constexpr uint16_t PRESSURE_UNIT_CODE_BAR = 3;

// The live measurement block for each kind - what AddressInspector's
// CONFIRM phase (below) reads repeatedly to tell two identical
// instruments apart, and what each registered slot's own poll
// (packages/pressure_sensor.yaml) reads every cycle. Declared here,
// ahead of AddressInspector, rather than down with decode_flow_block()/
// decode_pressure_bar() where they used to live - those decode a reply
// already in hand and never needed the register numbers themselves.
//
// One transaction for BOTH values a Flow slot needs - document registers
// 0001-0002 (instant rate) and 0009-0012 (accumulated total) live inside
// one contiguous 12-register block, so asking for the block costs a
// single request/reply pair instead of the two this used to run per slot
// per poll. Registers 0003-0008 are read and thrown away; reading them
// costs 12 bytes of extra reply time (~12 ms at 9600 baud) against a
// whole second request/reply pair (~40 ms) plus its own turnaround gap.
static constexpr uint16_t FLOW_BLOCK_START_REG = 0;   // document register "0001" - PDU addresses are document minus one
static constexpr uint16_t FLOW_BLOCK_REGISTERS = 12;  // through document register "0012" (the total's fractional part)
static constexpr uint16_t PRESSURE_BLOCK_START_REG = 22;
static constexpr uint16_t PRESSURE_BLOCK_REGISTERS = 2;

// A fingerprint read has four outcomes, not two. Folding them into a
// bool made this fragile: on a contended address the read fails BECAUSE
// two devices answered, and "it didn't match" is the one reading of that
// failure which is certainly wrong. DAMAGED is the fourth: bytes came
// back but no frame did. A fingerprint is only ever read from an address
// that has just answered a shorter request cleanly, so a longer reply
// arriving as garbage is not the line - it is two replies on top of each
// other.
enum class FingerprintResult : uint8_t { NO_MATCH, MATCH, CONTENDED, DAMAGED };

inline FingerprintResult flow_fingerprint(UARTComponent *bus, uint8_t address, uint32_t timeout_ms) {
  uint16_t regs[2];
  bool contended = false, damaged = false;
  bool read =
      read_holding_registers(bus, address, FLOW_SELFTEST_REG, 2, regs, 2, timeout_ms, &contended, nullptr, &damaged);
  if (contended) return FingerprintResult::CONTENDED;
  if (damaged) return FingerprintResult::DAMAGED;
  if (!read) return FingerprintResult::NO_MATCH;
  float value = decode_float_low_word_first(regs[0], regs[1]);
  return (std::isfinite(value) && std::fabs(value - FLOW_SELFTEST_VALUE) < 0.5f) ? FingerprintResult::MATCH
                                                                                 : FingerprintResult::NO_MATCH;
}

inline FingerprintResult pressure_fingerprint(UARTComponent *bus, uint8_t address, uint32_t timeout_ms) {
  uint16_t regs[4];
  bool contended = false, damaged = false;
  bool read = read_holding_registers(bus, address, PRESSURE_IDENTITY_REG, 4, regs, 4, timeout_ms, &contended, nullptr,
                                     &damaged);
  if (contended) return FingerprintResult::CONTENDED;
  if (damaged) return FingerprintResult::DAMAGED;
  if (!read) return FingerprintResult::NO_MATCH;
  return (regs[0] == address && regs[2] == PRESSURE_UNIT_CODE_BAR) ? FingerprintResult::MATCH
                                                                   : FingerprintResult::NO_MATCH;
}

struct Identity {
  DeviceKind kind{DeviceKind::UNKNOWN};
  // Both fingerprints answered. One device cannot be two instruments, so
  // this is two devices sharing an address - and it is the ONLY way to
  // see that particular fault.
  bool conflicting{false};
};

// One-use interlock between the dashboard's explicit address-change
// command and the persisted Number entity which stores the result. A
// Number update on its own is configuration data, never permission to
// transmit a hardware write. The nonce also makes a delayed duplicate of
// the complete command harmless for the remainder of this boot.
class AddressChangeAuthorization {
 public:
  bool arm(uint8_t old_address, uint8_t new_address, uint32_t nonce, uint32_t now_ms,
           uint32_t lifetime_ms = 5000) {
    if (old_address == 0 || new_address == 0 || old_address == new_address || nonce == 0 ||
        nonce == this->consumed_nonce_) {
      this->clear_();
      return false;
    }
    this->old_address_ = old_address;
    this->new_address_ = new_address;
    this->nonce_ = nonce;
    this->until_ms_ = now_ms + lifetime_ms;
    this->armed_ = true;
    return true;
  }

  bool consume(uint8_t old_address, uint8_t new_address, uint32_t now_ms) {
    bool allowed = this->armed_ && this->old_address_ == old_address && this->new_address_ == new_address &&
                   (int32_t) (now_ms - this->until_ms_) <= 0;
    uint32_t nonce = this->nonce_;
    this->clear_();  // before the caller can perform any blocking bus work
    if (allowed) this->consumed_nonce_ = nonce;
    return allowed;
  }

 private:
  void clear_() {
    this->armed_ = false;
    this->old_address_ = 0;
    this->new_address_ = 0;
    this->nonce_ = 0;
    this->until_ms_ = 0;
  }

  bool armed_{false};
  uint8_t old_address_{0};
  uint8_t new_address_{0};
  uint32_t nonce_{0};
  uint32_t consumed_nonce_{0};
  uint32_t until_ms_{0};
};

inline AddressChangeAuthorization &address_change_authorization(const char *key) {
  static constexpr size_t MAX_AUTHORIZATIONS = 4;
  struct Entry {
    const char *key;
    AddressChangeAuthorization authorization;
  };
  static Entry entries[MAX_AUTHORIZATIONS] = {};
  for (size_t i = 0; i < MAX_AUTHORIZATIONS; i++) {
    if (entries[i].key == nullptr) {
      entries[i].key = key;
      return entries[i].authorization;
    }
    if (std::strcmp(entries[i].key, key) == 0) return entries[i].authorization;
  }
  return entries[MAX_AUTHORIZATIONS - 1].authorization;
}

// Non-blocking counterpart of identify() for periodic slot checks. It
// asks the same two fingerprint questions and keeps the bus through each
// reply's tail-listen window, but every step returns immediately so the
// ESPHome loop can continue serving the dashboard.
class IdentityInspector {
 public:
  enum class Phase : uint8_t { IDLE, FLOW, TAIL_LISTEN, PRESSURE, DONE };

  bool start(uint8_t address, uint32_t timeout_ms) {
    // DONE still contains a result the scheduler has not consumed yet;
    // do not let a second caller silently overwrite it.
    if (this->phase_ != Phase::IDLE) return false;
    this->address_ = address;
    this->timeout_ms_ = timeout_ms;
    this->flow_ = FingerprintResult::NO_MATCH;
    this->pressure_ = FingerprintResult::NO_MATCH;
    this->result_ = Identity{};
    this->phase_ = Phase::FLOW;
    return true;
  }

  bool active() const { return this->phase_ != Phase::IDLE && this->phase_ != Phase::DONE; }
  bool done() const { return this->phase_ == Phase::DONE; }
  bool requires_bus_exclusive() const { return this->phase_ == Phase::TAIL_LISTEN; }
  uint8_t address() const { return this->address_; }

  void step(UARTComponent *bus, Transaction &tx) {
    if (!this->active()) return;
    if (this->phase_ == Phase::TAIL_LISTEN) {
      if (bus->available() >= SECOND_REPLY_MIN_BYTES) {
        flush_rx(bus);
        this->result_ = Identity{};
        this->result_.conflicting = true;
        this->phase_ = Phase::DONE;
        return;
      }
      if ((int32_t) (esphome::millis() - this->tail_until_ms_) < 0) return;
      flush_rx(bus);
      if (this->tail_next_ == Phase::DONE) this->finish_();
      else this->phase_ = this->tail_next_;
      return;
    }
    if (tx.busy()) {
      tx.poll(bus);
      return;
    }
    if (tx.done()) {
      this->consume_(tx);
      return;
    }
    if (this->phase_ == Phase::FLOW) {
      tx.start_read(bus, this->address_, FLOW_SELFTEST_REG, 2, this->timeout_ms_);
    } else if (this->phase_ == Phase::PRESSURE) {
      tx.start_read(bus, this->address_, PRESSURE_IDENTITY_REG, 4, this->timeout_ms_);
    }
  }

  Identity take_result() {
    Identity out = this->result_;
    this->phase_ = Phase::IDLE;
    return out;
  }

 private:
  static FingerprintResult flow_result_(AddressObservation obs, const uint16_t *regs, size_t received) {
    if (obs == AddressObservation::PROVEN_COLLISION) return FingerprintResult::CONTENDED;
    if (obs == AddressObservation::DAMAGED_ACTIVITY) return FingerprintResult::DAMAGED;
    if (obs != AddressObservation::VALID_RESPONSE || received < 2) return FingerprintResult::NO_MATCH;
    float value = decode_float_low_word_first(regs[0], regs[1]);
    return (std::isfinite(value) && std::fabs(value - FLOW_SELFTEST_VALUE) < 0.5f)
               ? FingerprintResult::MATCH
               : FingerprintResult::NO_MATCH;
  }

  FingerprintResult pressure_result_(AddressObservation obs, const uint16_t *regs, size_t received) const {
    if (obs == AddressObservation::PROVEN_COLLISION) return FingerprintResult::CONTENDED;
    if (obs == AddressObservation::DAMAGED_ACTIVITY) return FingerprintResult::DAMAGED;
    if (obs != AddressObservation::VALID_RESPONSE || received < 4) return FingerprintResult::NO_MATCH;
    return regs[0] == this->address_ && regs[2] == PRESSURE_UNIT_CODE_BAR ? FingerprintResult::MATCH
                                                                          : FingerprintResult::NO_MATCH;
  }

  static bool contended_(FingerprintResult result) {
    return result == FingerprintResult::CONTENDED || result == FingerprintResult::DAMAGED;
  }

  void enter_tail_(Phase next) {
    this->tail_next_ = next;
    this->tail_until_ms_ = esphome::millis() + SECOND_REPLY_WINDOW_MS;
    this->phase_ = Phase::TAIL_LISTEN;
  }

  void consume_(Transaction &tx) {
    AddressObservation obs = tx.observation();
    uint16_t regs[MAX_REGISTERS];
    size_t received = 0;
    tx.take(regs, MAX_REGISTERS, &received);
    if (this->phase_ == Phase::FLOW) {
      this->flow_ = flow_result_(obs, regs, received);
      if (contended_(this->flow_)) {
        this->result_.conflicting = true;
        this->phase_ = Phase::DONE;
      } else if (obs == AddressObservation::VALID_RESPONSE || obs == AddressObservation::EXCEPTION_RESPONSE) {
        this->enter_tail_(Phase::PRESSURE);
      } else {
        this->phase_ = Phase::PRESSURE;
      }
      return;
    }
    this->pressure_ = this->pressure_result_(obs, regs, received);
    if (contended_(this->pressure_)) {
      this->result_.conflicting = true;
      this->phase_ = Phase::DONE;
    } else if (obs == AddressObservation::VALID_RESPONSE || obs == AddressObservation::EXCEPTION_RESPONSE) {
      this->enter_tail_(Phase::DONE);
    } else {
      this->finish_();
    }
  }

  void finish_() {
    this->result_ = Identity{};
    if (this->flow_ == FingerprintResult::MATCH && this->pressure_ == FingerprintResult::MATCH) {
      this->result_.conflicting = true;
    } else if (this->flow_ == FingerprintResult::MATCH) {
      this->result_.kind = DeviceKind::FLOW;
    } else if (this->pressure_ == FingerprintResult::MATCH) {
      this->result_.kind = DeviceKind::PRESSURE;
    }
    this->phase_ = Phase::DONE;
  }

  Phase phase_{Phase::IDLE};
  Phase tail_next_{Phase::DONE};
  uint8_t address_{0};
  uint32_t timeout_ms_{0};
  uint32_t tail_until_ms_{0};
  FingerprintResult flow_{FingerprintResult::NO_MATCH};
  FingerprintResult pressure_{FingerprintResult::NO_MATCH};
  Identity result_{};
};

inline IdentityInspector &identity_inspector(const char *key) {
  static constexpr size_t MAX_INSPECTORS = 4;
  struct Entry {
    const char *key;
    IdentityInspector inspector;
  };
  static Entry entries[MAX_INSPECTORS] = {};
  for (size_t i = 0; i < MAX_INSPECTORS; i++) {
    if (entries[i].key == nullptr) {
      entries[i].key = key;
      return entries[i].inspector;
    }
    if (std::strcmp(entries[i].key, key) == 0) return entries[i].inspector;
  }
  return entries[MAX_INSPECTORS - 1].inspector;
}

// Runs BOTH fingerprints, always, even after the first one matches.
//
// That looks wasteful and is the whole point. Every other collision test
// in this file compares frames: two devices talking at once damage each
// other's CRC (TxResult::COLLISION), or one answers late enough to leave
// bytes behind after the other (probe()). Both are blind to two devices
// that answer with the SAME bytes - identical frames superimpose into a
// perfectly valid frame, even for two different makes and models, if the
// registers being read happen to hold the same value on both.
//
// Nothing about the bytes can separate that case. What separates it is
// asking a question the two devices answer differently, which is exactly
// what the fingerprints are: a T3 answers the 0361 self-test and a
// QDW90A does not, a QDW90A answers with its own address in H:0 and a T3
// does not. If both answer, there are two.
//
// UNKNOWN is an answer, not a failure - it means "something is there that
// this firmware does not recognise", and the only honest thing to do with
// it is say so rather than guess a type.
inline Identity identify(UARTComponent *bus, uint8_t address, uint32_t timeout_ms = 200) {
  Identity identity;
  FingerprintResult flow = flow_fingerprint(bus, address, timeout_ms);
  FingerprintResult pressure = pressure_fingerprint(bus, address, timeout_ms);
  // Two devices show up here in either of two ways, and both count.
  //
  // Both fingerprints answering is the clean case: one device cannot be
  // two instruments. The messier and more likely one is that a
  // fingerprint read comes back CONTENDED - damaged, or with a second
  // reply behind the first - because that is what happens when a
  // register only one of the two devices implements is read: one answers
  // with data and the other refuses, on top of each other. Reading that
  // as "no match" and then, with both reads failed, as a harmless
  // UNKNOWN is the one interpretation that is certainly wrong: the
  // fingerprints failed precisely BECAUSE two devices are there.
  // The raw verdicts, 0 = no match, 1 = match, 2 = contended, 3 = damaged
  // reply (bytes without a frame - see FingerprintResult). At DEBUG
  // only when they are anything but one clean match - that is the case
  // where, if the answer is wrong, nothing else in the log says which of
  // the two reads disagreed with expectations. A clean match is the
  // steady state: four registered slots re-check every ten seconds, so
  // logging it unconditionally put a line in the log every 2.5 s that
  // said the same thing as the last one, and the scan already reports
  // every found address with its type. The wire-level trace still shows
  // it, for when the check itself is being watched.
  auto two_devices = [](FingerprintResult r) {
    return r == FingerprintResult::CONTENDED || r == FingerprintResult::DAMAGED;
  };
  bool clean_match = !two_devices(flow) && !two_devices(pressure) &&
                     (flow == FingerprintResult::MATCH) != (pressure == FingerprintResult::MATCH);
  if (!clean_match) {
    ESP_LOGD(TAG, "address %d: fingerprints flow=%d pressure=%d", address, (int) flow, (int) pressure);
  } else if (trace_enabled()) {
    ESP_LOGVV(TAG, "address %d: fingerprints flow=%d pressure=%d", address, (int) flow, (int) pressure);
  }
  if (two_devices(flow) || two_devices(pressure) ||
      (flow == FingerprintResult::MATCH && pressure == FingerprintResult::MATCH)) {
    ESP_LOGW(TAG, "address %d: more than one device answers here (flow fingerprint %d, pressure fingerprint %d)",
             address, (int) flow, (int) pressure);
    identity.conflicting = true;
    return identity;  // kind stays UNKNOWN: no answer from here can be trusted
  }
  if (flow == FingerprintResult::MATCH) identity.kind = DeviceKind::FLOW;
  else if (pressure == FingerprintResult::MATCH) identity.kind = DeviceKind::PRESSURE;
  return identity;
}

inline DeviceKind identify_device(UARTComponent *bus, uint8_t address, uint32_t timeout_ms = 200) {
  return identify(bus, address, timeout_ms).kind;
}

// --- Address inspection: one shared evidence machine ----------------------
// "Is exactly one device answering here, and if so what is it" - the
// question a bus scan, an Add press, and an address-change safety check
// all ask. They used to ask it three different ways, with Add and the
// address-change check making do with one probe() and one identify() and
// missing collisions the scan's own retry logic would have caught. One
// state machine now answers the question for all three callers, so none
// of them can be weaker than the others by accident.
//
// Driven from the OUTSIDE, one Transaction step at a time (step() never
// waits) - the same shape as the central scheduler already drives each
// slot's own poll (water-telemetry-hub.yaml), and for the same reason:
// inspecting an address can take a dozen short transactions in the worst
// case, and NONE of them may block the main loop for a bus scan sweeping
// all 247 addresses to stay responsive. inspect_address_blocking() below
// wraps the identical steps in a spin-and-yield loop for the two callers
// (Add, address change) that only ever inspect one address at a time and
// are content to block for it, same as every other button-press action in
// this file.
//
// The sequence, and why each step exists:
//
//   PROBE_1        read H:0 (cheapest possible request).
//     SILENCE                -> nothing here, done.
//     PROVEN_COLLISION       -> certain, done.
//     VALID/EXCEPTION        -> something answered cleanly - listen for a
//                                trailing second frame (TAIL_LISTEN
//                                below) before going to PROBE_2.
//     DAMAGED_ACTIVITY       -> not proof by itself (a single noisy frame
//                                on a cold address could be a stray line
//                                glitch) - go to PROBE_1B to ask whether
//                                it repeats.
//   PROBE_1B       (only after DAMAGED_ACTIVITY) read H:0 again.
//     SILENCE                -> the first reply was a one-off glitch on an
//                                otherwise quiet line; done, nothing here.
//     DAMAGED_ACTIVITY/
//     PROVEN_COLLISION       -> the SAME kind of activity showing up again
//                                on a second, freshly-flushed request is
//                                what two devices sharing an address look
//                                like - a single device cannot repeat its
//                                own damage on demand. Proven, done.
//     VALID/EXCEPTION        -> a device IS here (this reply's CRC proves
//                                it), but a clean retry does not confirm
//                                the FIRST reply's damage was a collision
//                                - a single flaky device answering badly
//                                once and cleanly the next time looks
//                                exactly like this too, and calling that
//                                a certain collision is precisely the
//                                overclaiming this file exists to avoid.
//                                Treated the same as a clean PROBE_1:
//                                listen for a trailing second frame, then
//                                go to PROBE_2.
//   TAIL_LISTEN    (after ANY clean VALID/EXCEPTION reply, at every step
//                   below that says so) - the non-blocking equivalent of
//                   second_reply_follows() above, driven one step() at a
//                   time instead of spinning: a second device answering
//                   the SAME request a whole frame behind the first would
//                   otherwise sit unseen in the UART buffer until the
//                   very next request's start_request() silently flushes
//                   it away, letting two devices answering back to back
//                   read as one.
//     enough bytes arrive within the window -> only a second device could
//                                                be talking once ours has
//                                                already finished; proven,
//                                                done.
//     window elapses with nothing/too little  -> genuinely one reply; go
//                                                on to whichever phase
//                                                this listen was for.
//   PROBE_2        (only after a clean PROBE_1/PROBE_1B and its tail
//                   listen) read H:0 again - catches two devices whose
//                   alignment differs between rounds, which a single
//                   probe cannot.
//     PROVEN_COLLISION / DAMAGED_ACTIVITY (a damaged reply right after a
//     clean one from the SAME address is exactly the "just answered
//     cleanly" correlation identify()'s own fingerprints already rely on)
//                            -> proven, done.
//     SILENCE                -> retried once (see
//                                ADDRESS_INSPECTOR_SILENCE_RETRIES) before
//                                giving up - a device that just answered
//                                PROBE_1 cleanly going quiet on the very
//                                next request is not itself proof of
//                                anything, but it also means this address
//                                can no longer be confirmed as exactly one
//                                clean device; see the ambiguous-verdict
//                                note below.
//     VALID/EXCEPTION        -> tail listen, then FP_FLOW.
//   FP_FLOW, FP_PRESSURE     the two identify() fingerprints - catch two
//                             DIFFERENT instruments sharing an address,
//                             which nothing about frame shape alone can
//                             show (see identify()'s own comment). SILENCE
//                             here is NOT retried like PROBE_2's/CONFIRM's
//                             own is - each fingerprint asks about a
//                             DIFFERENT, optional register (self-test /
//                             identity block) than the H:0 read PROBE_1/
//                             PROBE_2 already got answered, and a real
//                             single device having nothing to say about
//                             one specific register it does not implement
//                             is exactly what classify_*_fingerprint_()
//                             already reports as NO_MATCH - informative,
//                             not ambiguous.
//     CONTENDED/DAMAGED on either, or both MATCH -> proven, done.
//     otherwise               -> kind established (or UNKNOWN); tail
//                                listen, then CONFIRM.
//   CONFIRM x N    repeated reads of the live measurement block for the
//                   established kind (the probe register again if
//                   UNKNOWN) - catches two IDENTICAL instruments, which
//                   answer every fixed-content read the same way and can
//                   only be told apart by something that actually varies.
//     PROVEN_COLLISION/DAMAGED at any read -> proven, done.
//     a read that is not VALID_RESPONSE (SILENCE, or an EXCEPTION where a
//     clean measurement was expected) does NOT count toward N - retried
//     once (like PROBE_2's own SILENCE, since this asks about the exact
//     register block a fingerprint just proved this device answers),
//     then treated as ambiguous. Any non-collision outcome counting
//     toward N would let a device that answered PROBE_1 once and then
//     went silent for the rest of the sequence still reach "N reads all
//     clean" without ever having a clean read.
//     N genuinely clean VALID_RESPONSE reads, each tail-listened -> singly
//                                occupied, done.
//
// The ambiguous verdict: PROBE_2 and CONFIRM can each reach a point -
// after their own retry budget - where something has proven this address
// is not silent (an earlier phase got a real, CRC-valid reply), but
// nothing can now confirm either "exactly one clean device" or "two
// devices, proven" on the exact same register that reply answered. That
// is reported as DAMAGED_ACTIVITY, not PROVEN_COLLISION and not
// VALID_RESPONSE - see verdict()'s own comment for what each caller does
// with it: "suspected, not proven". Every write-safety check in this
// codebase already treats anything other than a clean VALID_RESPONSE
// (for the address being written FROM) or a clean SILENCE (for the
// address being written TO) as reason enough to refuse, so this refuses
// exactly like a proven collision would without this file ever calling
// it one.
//
// What this deliberately does NOT do: call one noisy frame on a
// previously-silent address a certainty (PROBE_1B asks it to repeat
// first), call a clean retry after damage a certainty either (a single
// flaky device can do that too - see PROBE_1B above), or call an
// unconfirmable address a proven collision merely because it went quiet
// (see the ambiguous verdict above). Two genuinely identical devices
// whose transmitters drift into exact alignment for the whole CONFIRM run
// are not distinguishable from one device by anything on the wire -
// CONFIRM_READS lowers that chance to a small, stated one (see its own
// comment), not to zero, and nothing in this file claims otherwise.
static constexpr int ADDRESS_INSPECTOR_CONFIRM_READS = 8;

// How many times PROBE_2 or a single CONFIRM read may retry an
// unexpected SILENCE (or, for CONFIRM, an unexpected EXCEPTION_RESPONSE)
// before the inspector accepts it cannot confirm this address any
// further. Deliberately NOT used by FP_FLOW/FP_PRESSURE - see those
// phases' own comments for why their SILENCE is ordinary NO_MATCH
// evidence, not something to retry. One retry, not zero: a device that
// has already proven itself present (an earlier phase got a real reply
// to this EXACT register) missing a single poll is plausible line jitter,
// not evidence by itself - but a SECOND consecutive miss on the same
// question is no longer something a retry should paper over silently.
static constexpr int ADDRESS_INSPECTOR_SILENCE_RETRIES = 1;

class AddressInspector {
 public:
  enum class Phase : uint8_t { IDLE, PROBE_1, PROBE_1B, TAIL_LISTEN, PROBE_2, FP_FLOW, FP_PRESSURE, CONFIRM, DONE };

  void start(uint8_t address, uint32_t timeout_ms) {
    this->address_ = address;
    this->timeout_ms_ = timeout_ms;
    this->phase_ = Phase::PROBE_1;
    this->confirm_done_ = 0;
    this->silence_retries_ = 0;
    this->kind_ = DeviceKind::UNKNOWN;
    this->flow_result_ = FingerprintResult::NO_MATCH;
    this->verdict_ = AddressObservation::SILENCE;
  }

  bool done() const { return this->phase_ == Phase::DONE; }
  bool idle() const { return this->phase_ == Phase::IDLE; }
  // A tail-listen has no Transaction in flight, but it still owns the
  // physical bus: another request would flush or consume the delayed
  // second reply this phase exists to detect.
  bool requires_bus_exclusive() const { return this->phase_ == Phase::TAIL_LISTEN; }

  // Final answer, only meaningful once done(). One of SILENCE (nothing
  // there), VALID_RESPONSE (exactly one device, kind() tells what),
  // PROVEN_COLLISION (certain - a frame shape or correlated repeat only
  // two devices could produce), or DAMAGED_ACTIVITY, reused here to mean
  // "ambiguous": something proved this address is not silent, but this
  // pass could not confirm either a single clean device or a proven
  // collision (see the class comment's "ambiguous verdict" paragraph).
  // EXCEPTION_RESPONSE never comes out of here - it is always resolved
  // into one of the four above by the time the sequence reaches DONE.
  //
  // Every caller already treats DAMAGED_ACTIVITY the same as
  // PROVEN_COLLISION for anything that matters: the scan reports it in
  // neither found nor collisions (an unproven claim either way would be
  // worse than none), and both write-safety checks in
  // packages/pressure_sensor.yaml already refuse on anything but a clean
  // VALID_RESPONSE (current address) or a clean SILENCE (target address)
  // - DAMAGED_ACTIVITY is neither, so it refuses exactly like a proven
  // collision would, without this file ever calling it one.
  AddressObservation verdict() const { return this->verdict_; }
  DeviceKind kind() const { return this->kind_; }

  // Advances by at most one Transaction step: polls one already in
  // flight, services the tail-listen window, or starts the next
  // Transaction this phase needs. Never waits - the caller decides how
  // (and whether) to wait between calls.
  void step(UARTComponent *bus, Transaction &tx) {
    if (this->idle() || this->done()) return;
    if (this->phase_ == Phase::TAIL_LISTEN) {
      this->poll_tail_listen_(bus);
      return;
    }
    if (tx.busy()) {
      tx.poll(bus);
      return;
    }
    if (tx.done()) {
      this->on_transaction_done_(tx);
      return;
    }
    // tx.idle(): nothing in flight - fire whatever this phase needs.
    this->start_phase_request_(bus, tx);
  }

 private:
  void start_phase_request_(UARTComponent *bus, Transaction &tx) {
    switch (this->phase_) {
      case Phase::PROBE_1:
      case Phase::PROBE_1B:
      case Phase::PROBE_2:
        tx.start_read(bus, this->address_, 0, 1, this->timeout_ms_);
        return;
      case Phase::FP_FLOW:
        tx.start_read(bus, this->address_, FLOW_SELFTEST_REG, 2, this->timeout_ms_);
        return;
      case Phase::FP_PRESSURE:
        tx.start_read(bus, this->address_, PRESSURE_IDENTITY_REG, 4, this->timeout_ms_);
        return;
      case Phase::CONFIRM: {
        uint16_t start = 0, count = 1;
        if (this->kind_ == DeviceKind::FLOW) {
          start = FLOW_BLOCK_START_REG;
          count = FLOW_BLOCK_REGISTERS;
        } else if (this->kind_ == DeviceKind::PRESSURE) {
          start = PRESSURE_BLOCK_START_REG;
          count = PRESSURE_BLOCK_REGISTERS;
        }
        tx.start_read(bus, this->address_, start, count, this->timeout_ms_);
        return;
      }
      default:
        return;
    }
  }

  void finish_(AddressObservation verdict) {
    this->verdict_ = verdict;
    this->phase_ = Phase::DONE;
  }

  // Enters the non-blocking wait for a second device's reply trailing
  // this phase's own clean one - see the class comment's TAIL_LISTEN
  // paragraph and SECOND_REPLY_WINDOW_MS/SECOND_REPLY_MIN_BYTES above.
  // `next_phase` is where to resume once the window elapses with nothing
  // - Phase::DONE doubles as "finish VALID_RESPONSE", the only case that
  // needs it (CONFIRM's Nth clean read).
  void enter_tail_listen_(Phase next_phase) {
    this->tail_next_phase_ = next_phase;
    this->tail_listen_until_ms_ = esphome::millis() + SECOND_REPLY_WINDOW_MS;
    this->silence_retries_ = 0;  // a fresh phase gets its own retry budget
    this->phase_ = Phase::TAIL_LISTEN;
  }

  void poll_tail_listen_(UARTComponent *bus) {
    if (bus->available() >= SECOND_REPLY_MIN_BYTES) {
      // Bytes sitting in the buffer immediately after a reply that just
      // validated cleanly can only be a second device's reply trailing
      // the first - our own device has nothing left to say once it has
      // answered. Exactly second_reply_follows()'s own check above,
      // driven one step at a time so the scan's non-blocking sweep sees
      // it too, instead of the next phase's start_request() silently
      // flushing it away unread.
      flush_rx(bus);
      this->finish_(AddressObservation::PROVEN_COLLISION);
      return;
    }
    if ((int32_t) (esphome::millis() - this->tail_listen_until_ms_) < 0) return;  // still listening
    flush_rx(bus);  // discard any stray sub-threshold noise - see SECOND_REPLY_MIN_BYTES
    if (this->tail_next_phase_ == Phase::DONE) {
      this->finish_(AddressObservation::VALID_RESPONSE);
    } else {
      this->phase_ = this->tail_next_phase_;
    }
  }

  void on_transaction_done_(Transaction &tx) {
    AddressObservation obs = tx.observation();
    uint16_t regs[MAX_REGISTERS];
    size_t received = 0;
    tx.take(regs, MAX_REGISTERS, &received);
    switch (this->phase_) {
      case Phase::PROBE_1:
        if (obs == AddressObservation::SILENCE) {
          this->finish_(AddressObservation::SILENCE);
        } else if (obs == AddressObservation::PROVEN_COLLISION) {
          this->finish_(AddressObservation::PROVEN_COLLISION);
        } else if (obs == AddressObservation::DAMAGED_ACTIVITY) {
          this->phase_ = Phase::PROBE_1B;
        } else if (obs == AddressObservation::VALID_RESPONSE || obs == AddressObservation::EXCEPTION_RESPONSE) {
          this->enter_tail_listen_(Phase::PROBE_2);
        }
        return;
      case Phase::PROBE_1B:
        // Correlation, not a second independent guess: the first probe
        // already proved SOMETHING is transmitting at this address.
        if (obs == AddressObservation::SILENCE) {
          // The first reply was a passing glitch on an otherwise quiet
          // line - nothing here.
          this->finish_(AddressObservation::SILENCE);
        } else if (obs == AddressObservation::DAMAGED_ACTIVITY || obs == AddressObservation::PROVEN_COLLISION) {
          // The SAME kind of activity showing up again on a second,
          // freshly-flushed request is what two devices sharing an
          // address look like - a single device cannot repeat its own
          // damage on demand.
          this->finish_(AddressObservation::PROVEN_COLLISION);
        } else if (obs == AddressObservation::VALID_RESPONSE || obs == AddressObservation::EXCEPTION_RESPONSE) {
          // A clean VALID/EXCEPTION reply here proves a device IS
          // present, but does NOT confirm the first reply's damage was a
          // collision - a single flaky device can answer badly once and
          // cleanly the next time. Treat it exactly like a clean PROBE_1:
          // listen for a trailing second frame, then continue as normal.
          this->enter_tail_listen_(Phase::PROBE_2);
        }
        return;
      case Phase::PROBE_2:
        if (obs == AddressObservation::PROVEN_COLLISION || obs == AddressObservation::DAMAGED_ACTIVITY) {
          this->finish_(AddressObservation::PROVEN_COLLISION);
        } else if (obs == AddressObservation::SILENCE) {
          this->retry_or_give_up_();
        } else {
          this->enter_tail_listen_(Phase::FP_FLOW);
        }
        return;
      case Phase::FP_FLOW:
        this->flow_result_ = this->classify_flow_fingerprint_(obs, regs, received);
        if (this->flow_result_ == FingerprintResult::CONTENDED || this->flow_result_ == FingerprintResult::DAMAGED) {
          this->finish_(AddressObservation::PROVEN_COLLISION);
        } else if (obs == AddressObservation::VALID_RESPONSE || obs == AddressObservation::EXCEPTION_RESPONSE) {
          // SILENCE here is not the same kind of evidence PROBE_2's or
          // CONFIRM's own SILENCE is: this asks a DIFFERENT, optional
          // register (the flow self-test, not the H:0 address register
          // PROBE_1/PROBE_2 already got answered) that a real single
          // device - a QDW90A pressure sensor, most of the time - is
          // entirely expected to have nothing to say about. That is
          // exactly what classify_flow_fingerprint_() already reports as
          // NO_MATCH, and NO_MATCH is not ambiguous, it is informative -
          // try the other fingerprint next, same as always. No retry
          // budget spent here.
          this->enter_tail_listen_(Phase::FP_PRESSURE);
        } else {
          // SILENCE is the expected NO_MATCH for devices which do not
          // implement this optional fingerprint. With no completed reply
          // there is no reply tail to listen for.
          this->silence_retries_ = 0;
          this->phase_ = Phase::FP_PRESSURE;
        }
        return;
      case Phase::FP_PRESSURE: {
        auto pressure_result = this->classify_pressure_fingerprint_(obs, regs, received);
        bool two_devices = pressure_result == FingerprintResult::CONTENDED ||
                           pressure_result == FingerprintResult::DAMAGED ||
                           (this->flow_result_ == FingerprintResult::MATCH && pressure_result == FingerprintResult::MATCH);
        if (two_devices) {
          this->finish_(AddressObservation::PROVEN_COLLISION);
          return;
        }
        // Same reasoning as FP_FLOW above: SILENCE on this specific,
        // optional register is NO_MATCH, not ambiguity.
        if (this->flow_result_ == FingerprintResult::MATCH) this->kind_ = DeviceKind::FLOW;
        else if (pressure_result == FingerprintResult::MATCH) this->kind_ = DeviceKind::PRESSURE;
        this->confirm_done_ = 0;
        if (obs == AddressObservation::VALID_RESPONSE || obs == AddressObservation::EXCEPTION_RESPONSE) {
          this->enter_tail_listen_(Phase::CONFIRM);
        } else {
          // Same as FP_FLOW: SILENCE is a legitimate NO_MATCH, not a
          // completed response with a possible trailing second frame.
          this->silence_retries_ = 0;
          this->phase_ = Phase::CONFIRM;
        }
        return;
      }
      case Phase::CONFIRM:
        if (obs == AddressObservation::PROVEN_COLLISION || obs == AddressObservation::DAMAGED_ACTIVITY) {
          this->finish_(AddressObservation::PROVEN_COLLISION);
          return;
        }
        if (obs != AddressObservation::VALID_RESPONSE) {
          // SILENCE, or an EXCEPTION where the block the fingerprint just
          // proved this device supports was expected to read cleanly -
          // neither is the confirmation this read needs, and neither is
          // proof of a second device. Does NOT advance confirm_done_ (a
          // non-answer is not a clean read - see this class's own
          // "ambiguous verdict" note for why counting it used to let an
          // address that answered exactly once pass as a confirmed
          // single device).
          this->retry_or_give_up_();
          return;
        }
        this->confirm_done_++;
        if (this->confirm_done_ >= ADDRESS_INSPECTOR_CONFIRM_READS) {
          this->enter_tail_listen_(Phase::DONE);
        } else {
          this->enter_tail_listen_(Phase::CONFIRM);
        }
        return;
      default:
        return;
    }
  }

  // Shared by PROBE_2/FP_FLOW/FP_PRESSURE/CONFIRM's SILENCE handling:
  // retry the SAME phase's request once (see
  // ADDRESS_INSPECTOR_SILENCE_RETRIES), then settle for the honest,
  // conservative answer - see verdict()'s own comment for what
  // DAMAGED_ACTIVITY means as a terminal result here.
  void retry_or_give_up_() {
    if (this->silence_retries_ < ADDRESS_INSPECTOR_SILENCE_RETRIES) {
      this->silence_retries_++;
      return;  // phase_ unchanged - the next tx.idle() reissues the same request
    }
    this->finish_(AddressObservation::DAMAGED_ACTIVITY);
  }

  // Same rules as flow_fingerprint()/pressure_fingerprint() above, applied
  // to a reply already read and classified as an AddressObservation
  // instead of driven through the blocking read_holding_registers().
  static FingerprintResult classify_flow_fingerprint_(AddressObservation obs, const uint16_t *regs, size_t received) {
    if (obs == AddressObservation::PROVEN_COLLISION) return FingerprintResult::CONTENDED;
    if (obs == AddressObservation::DAMAGED_ACTIVITY) return FingerprintResult::DAMAGED;
    if (obs != AddressObservation::VALID_RESPONSE || received < 2) return FingerprintResult::NO_MATCH;
    float value = decode_float_low_word_first(regs[0], regs[1]);
    return (std::isfinite(value) && std::fabs(value - FLOW_SELFTEST_VALUE) < 0.5f) ? FingerprintResult::MATCH
                                                                                   : FingerprintResult::NO_MATCH;
  }

  FingerprintResult classify_pressure_fingerprint_(AddressObservation obs, const uint16_t *regs,
                                                    size_t received) const {
    if (obs == AddressObservation::PROVEN_COLLISION) return FingerprintResult::CONTENDED;
    if (obs == AddressObservation::DAMAGED_ACTIVITY) return FingerprintResult::DAMAGED;
    if (obs != AddressObservation::VALID_RESPONSE || received < 4) return FingerprintResult::NO_MATCH;
    return (regs[0] == this->address_ && regs[2] == PRESSURE_UNIT_CODE_BAR) ? FingerprintResult::MATCH
                                                                            : FingerprintResult::NO_MATCH;
  }

 private:
  uint8_t address_{0};
  uint32_t timeout_ms_{0};
  Phase phase_{Phase::IDLE};
  int confirm_done_{0};
  int silence_retries_{0};
  Phase tail_next_phase_{Phase::DONE};
  uint32_t tail_listen_until_ms_{0};
  DeviceKind kind_{DeviceKind::UNKNOWN};
  FingerprintResult flow_result_{FingerprintResult::NO_MATCH};
  AddressObservation verdict_{AddressObservation::SILENCE};
};

// --- Address-CSV helpers -------------------------------------------------
// Shared by update_scan_result_address()/set_scan_collision_address()
// below - both read-modify-write a "Scan Results"/"Scan Collisions"-
// shaped text_sensor (comma-separated decimal addresses, e.g. "1,4,9").

inline std::vector<uint8_t> parse_address_csv(const std::string &csv) {
  std::vector<uint8_t> addresses;
  size_t start = 0;
  while (start <= csv.size()) {
    size_t comma = csv.find(',', start);
    std::string token = csv.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
    int parsed = atoi(token.c_str());
    if (parsed > 0 && parsed <= 247) addresses.push_back(static_cast<uint8_t>(parsed));
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return addresses;
}

inline std::string join_address_csv(std::vector<uint8_t> addresses) {
  std::sort(addresses.begin(), addresses.end());
  std::string csv;
  for (size_t i = 0; i < addresses.size(); i++) {
    if (i > 0) csv += ",";
    csv += std::to_string(addresses[i]);
  }
  return csv;
}

struct ScanResult {
  std::vector<uint8_t> found;
  // Parallel to `found`: what each answering device turned out to be, so
  // the dashboard can offer the right Device Type instead of asking
  // someone to know it. DeviceKind::UNKNOWN where the fingerprints did
  // not recognise it - which stays a question for the person, not a
  // guess by the firmware.
  std::vector<DeviceKind> kinds;
  std::vector<uint8_t> collisions;
};

// The one-address version, for the two callers that only ever need to
// know about a single address and are content to block for it - Add and
// an address change (packages/pressure_sensor.yaml's Modbus Address
// set_action) - exactly the same one-shot-button-press cost every other
// action in this file already pays (address_confirmed() alone already
// blocks for up to 3 retries x timeout_ms). Spins AddressInspector's
// steps in a tight yield loop, same shape as read_holding_registers()'s
// own wait.
inline AddressInspector inspect_address_blocking(UARTComponent *bus, uint8_t address, uint32_t timeout_ms) {
  drain_poll_transaction(bus);
  Transaction tx;
  AddressInspector inspector;
  inspector.start(address, timeout_ms);
  while (!inspector.done()) {
    esphome::App.feed_wdt();
    esphome::yield();
    inspector.step(bus, tx);
  }
  return inspector;
}

// The 1-247 sweep, driven one Transaction step at a time from OUTSIDE
// (the central scheduler's interval tick, water-telemetry-hub.yaml) -
// never a spin loop. This replaces the version that used to run the
// entire sweep inside one button-press lambda: (max-min+1) addresses at
// up to a dozen short reads each, blocking the ENTIRE main loop for the
// whole ~12 s a full sweep takes - during which the SSE stream
// (AsyncEventSource::loop(), our own components/web_server_idf fork)
// never got to run, so "Scan In Progress" going true and then false
// moments later, queued back to back, had no main-loop turn in between
// to actually deliver the first one - which is why the spinner sometimes
// never appeared on the dashboard at all, not merely "sometimes late".
//
// One AddressInspector at a time, using the SAME shared poll_transaction()
// singleton the periodic per-slot poll and every one-shot button action
// already serialise through - not a private Transaction of its own. That
// is what makes drain_poll_transaction() (called by Add/address-change,
// and by nothing else the scan itself needs) correctly wait out and
// clean up whatever the scan left in flight if a button is pressed
// mid-sweep, exactly as it already does for an interrupted slot poll.
// Normal per-slot polling simply does not get a turn while a scan is
// active - see the central scheduler's own comment for where that gate
// lives - so the two can never contend for the bus at once.
class ScanController {
 public:
  // Starts a sweep unless one is already running - false and otherwise a
  // no-op in that case, so a second press of "Find Modbus Devices" while
  // one sweep is in flight cannot start (or queue) a second one.
  bool start(uint8_t min_address, uint8_t max_address, uint32_t per_address_timeout_ms) {
    if (this->active()) return false;
    this->min_address_ = min_address;
    this->max_address_ = max_address;
    this->timeout_ms_ = per_address_timeout_ms;
    this->current_address_ = min_address;
    this->result_ = ScanResult{};
    this->inspector_.start(min_address, per_address_timeout_ms);
    this->sweeping_ = true;
    ESP_LOGD(TAG, "scan: sweeping addresses %d-%d, one step at a time", min_address, max_address);
    return true;
  }

  bool active() const { return this->sweeping_; }
  bool requires_bus_exclusive() const {
    return this->sweeping_ && this->inspector_.requires_bus_exclusive();
  }
  // 0 when idle - lets the dashboard-facing progress number double as
  // "a scan is running" without a second entity.
  uint8_t current_address() const { return this->sweeping_ ? this->current_address_ : 0; }
  uint8_t min_address() const { return this->min_address_; }
  uint8_t max_address() const { return this->max_address_; }

  // Advances by at most one Transaction step (via the shared `tx`).
  // Returns true exactly once - on the step() call that completes the
  // whole sweep - so the caller knows take_result() is ready THIS tick,
  // without polling active() every tick to notice the edge.
  bool step(UARTComponent *bus, Transaction &tx) {
    if (!this->sweeping_) return false;
    this->inspector_.step(bus, tx);
    if (!this->inspector_.done()) return false;
    switch (this->inspector_.verdict()) {
      case AddressObservation::PROVEN_COLLISION:
        this->result_.collisions.push_back(this->current_address_);
        break;
      case AddressObservation::VALID_RESPONSE:
        this->result_.found.push_back(this->current_address_);
        this->result_.kinds.push_back(this->inspector_.kind());
        break;
      case AddressObservation::DAMAGED_ACTIVITY:
        // Ambiguous, not proven - see AddressInspector::verdict()'s own
        // comment. Logged rather than silent (something real did happen
        // here, unlike true SILENCE below) but deliberately reported in
        // neither found nor collisions: this file does not get to assert
        // a certainty it does not have, in either direction. A rescan or
        // the slot's own live polling (once registered) gets another
        // chance to resolve it.
        ESP_LOGW(TAG, "scan: address %d answered but could not be confirmed as one device or a proven collision - "
                      "neither found nor flagged, rescan to resolve",
                 this->current_address_);
        break;
      default:
        break;  // SILENCE - nothing at this address
    }
    if (this->current_address_ >= this->max_address_) {
      this->sweeping_ = false;
      return true;
    }
    this->current_address_++;
    this->inspector_.start(this->current_address_, this->timeout_ms_);
    return false;
  }

  // Only meaningful right after step() returned true.
  ScanResult take_result() { return this->result_; }

 private:
  bool sweeping_{false};
  uint8_t min_address_{0};
  uint8_t max_address_{0};
  uint8_t current_address_{0};
  uint32_t timeout_ms_{0};
  AddressInspector inspector_;
  ScanResult result_;
};

// One instance, same reasoning (and the same reason it cannot be an
// ESPHome global) as slot_link()/poll_transaction() above.
inline ScanController &scan_controller() {
  static ScanController instance;
  return instance;
}

// Folds a finished sweep's collision findings into the shared "Scan
// Collisions" CSV without discarding what live per-slot polling knows
// that a single scan pass cannot re-derive.
//
// The CSV has always served two owners: a registered slot's own poll
// adds/removes its own single address as its SlotLinkState evidence
// changes (set_scan_collision_address(), called from each slot's
// _poll_finish) - and a scan, which is the ONLY authority for an address
// nobody has registered, since nothing else ever asks it a question
// between scans. A scan that overwrites the whole CSV wholesale would
// discard whatever a registered slot's own continuous polling had JUST
// proven about its own address, on the strength of one independent pass
// with its own alignment luck - which is exactly the kind of self-
// erasure the identity-check ownership rule (note_poll()/
// identity_may_clear_collision() above) already exists to prevent for
// live polling, so the scan must not reintroduce it from the other side.
//
// So, and this is deliberately asymmetric (a symmetric version is wrong,
// see below): within the addresses this sweep actually covered,
//
//  - an UNREGISTERED address is fully re-decided by this pass: added if
//    this sweep found a collision there, removed if it didn't (a fixed
//    wiring fault has to be able to clear, and nothing else is watching
//    that address between scans to disagree);
//
//  - a REGISTERED address's own live-poll verdict is never REMOVED by a
//    clean scan pass - a scan is only as reliable as its own alignment
//    luck on that one sweep, exactly the reason note_poll()/
//    identity_may_clear_collision() above refuse to let one clean sample
//    undo it either - but a collision this sweep DID find at a
//    registered address is still real, corroborating evidence and IS
//    added. The first version of this function skipped scan_collisions
//    entirely for a registered address (`if (is_registered(a)) continue`
//    before ever adding), which meant a scan that positively caught a
//    second device sharing an already-registered address discarded that
//    exact finding at publish time - the one case a scan exists to catch
//    that the slot's own single-address polling structurally cannot
//    (nothing else on this firmware ever asks a SECOND question at a
//    registered slot's address). Addition and removal are not the same
//    operation and must not share one guard.
//
// Addresses outside the swept range are untouched either way.
inline std::string reconcile_scan_collisions(const std::string &old_csv, uint8_t min_address, uint8_t max_address,
                                              const std::vector<uint8_t> &registered_addresses,
                                              const std::vector<uint8_t> &scan_collisions) {
  auto is_registered = [&](uint8_t a) {
    return std::find(registered_addresses.begin(), registered_addresses.end(), a) != registered_addresses.end();
  };
  std::vector<uint8_t> kept;
  for (uint8_t a : parse_address_csv(old_csv)) {
    bool swept = a >= min_address && a <= max_address;
    if (swept && !is_registered(a)) continue;  // this sweep re-decides an unregistered address below
    kept.push_back(a);  // registered (or outside the swept range) - keep as-is, see above
  }
  for (uint8_t a : scan_collisions) {
    // Addition is allowed for every address this sweep found a collision
    // on, registered or not - only REMOVAL is off limits for a
    // registered address, and removal never runs through this loop.
    if (std::find(kept.begin(), kept.end(), a) == kept.end()) kept.push_back(a);
  }
  return join_address_csv(kept);
}

// --- Decoded-value plausibility ------------------------------------------
// A CRC-valid frame only proves the bytes survived the wire, not that
// they mean anything: a device answering a register block it doesn't
// actually implement, a half-configured unit, or a genuine bus collision
// whose CRC happens to pass all decode into some float, and NaN/inf or
// an absurd magnitude then propagates straight into a published sensor
// state (and, for a Flow slot, into the stored raw reading the Update
// button computes its correction from). Each read below screens its own
// decoded value against a deliberately generous window - wide enough
// that no real instrument reading can trip it, narrow enough that
// garbage cannot pass as a measurement.
static constexpr float PRESSURE_MIN_BAR = -100.0f;   // QDW90A models exist down to vacuum ranges
static constexpr float PRESSURE_MAX_BAR = 1000.0f;   // ...and up to several hundred bar
static constexpr float FLOW_MIN_M3H = -10000.0f;     // T3-1-2-H measures reverse flow too
static constexpr float FLOW_MAX_M3H = 10000.0f;

inline bool plausible(float value, float min_value, float max_value) {
  return std::isfinite(value) && value >= min_value && value <= max_value;
}

// Decodes the QDW90A pressure register pair (document H:22-23, high word
// first). Decode only: the read itself belongs to the scheduler's
// non-blocking Transaction (see water-telemetry-hub.yaml and each slot's own
// _poll_finish script), so there is deliberately no blocking
// blocking convenience wrapper left to accidentally call from the
// polling path.
inline bool decode_pressure_bar(const uint16_t *regs, float &out) {
  uint32_t bits = (static_cast<uint32_t>(regs[0]) << 16) | regs[1];
  float value;
  std::memcpy(&value, &bits, sizeof(value));
  if (!plausible(value, PRESSURE_MIN_BAR, PRESSURE_MAX_BAR)) return false;
  out = value;
  return true;
}

// Word order for every 32-bit (2-register) T3-1-2-H value below - LOW word
// first (the register at the lower address holds the low 16 bits, the next
// register holds the high 16 bits). Confirmed against the manufacturer's
// own communication self-test register pair (document 0361-0362,
// documented to read back exactly 361.0): it only decodes to that exact
// value with this word order - the opposite order decodes it to a
// meaningless denormalized near-zero float instead. Cross-checked
// against the instant flow rate too (matched a directly observed
// ~0.5 m3/h while water was actually running). QDW90A
// (decode_pressure_bar() above) is a different manufacturer/protocol
// entirely and is NOT affected - its own word order is independent of
// this and untouched here.
inline float decode_float_low_word_first(uint16_t low, uint16_t high) {
  uint32_t bits = (static_cast<uint32_t>(high) << 16) | low;
  float value;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

// Total accumulated volume, in whole MILLILITRES - deliberately not a
// float. read_flow_total() used to hand back (N + Nf) / 1000.0f m3, and
// every consumer of it (the stored raw reading, the calibration offset,
// the published total) then carried that float32 forward: at a few tens
// of m3 a float32's own spacing is already coarser than the millilitre
// this instrument actually reports, so the last digits of a "6 decimal"
// reading stopped being real long before the meter did. N is an exact
// integer litre count and Nf an exact fraction of one litre, so the
// millilitre value is exactly representable as an integer - this returns
// that, and the float only ever appears at the very end, in the
// published sensor state (see packages/pressure_sensor.yaml).
//
// NOT the documented (N+Nf)*10^n via the document-1439 scale-exponent
// register - that register reads a plain, repeatable 0 on this unit (a
// single-register read, so this isn't a word-order question), and using
// it as documented would leave the total unscaled by a factor of 1000.
// N is a plain litre count instead, confirmed against a directly
// measured sample; no dependency on document register 1439 at all.
inline bool decode_flow_total_ml(uint32_t n_bits, uint32_t nf_bits, int64_t &out_ml) {
  float nf;
  std::memcpy(&nf, &nf_bits, sizeof(nf));
  // The fractional part is a fraction of one litre by definition -
  // anything outside [0, 1) means these registers aren't carrying what
  // we think they are, so the whole reading is refused rather than
  // silently contributing a wrong sub-litre remainder.
  if (!std::isfinite(nf) || nf < 0.0f || nf >= 1.0f) return false;
  out_ml = static_cast<int64_t>(n_bits) * 1000 + static_cast<int64_t>(std::lroundf(nf * 1000.0f));
  return true;
}

// Decodes the 12-register Flow block into both of the values a Flow slot
// publishes - see FLOW_BLOCK_START_REG above for why they come from one
// read. Decode only, same reasoning as decode_pressure_bar() above.
inline bool decode_flow_block(const uint16_t *regs, float &instant_m3h, int64_t &total_ml) {
  float instant = decode_float_low_word_first(regs[0], regs[1]);
  if (!plausible(instant, FLOW_MIN_M3H, FLOW_MAX_M3H)) return false;
  uint32_t n_bits = (static_cast<uint32_t>(regs[9]) << 16) | regs[8];     // document 0009-0010, LONG integer part
  uint32_t nf_bits = (static_cast<uint32_t>(regs[11]) << 16) | regs[10];  // document 0011-0012, IEEE754 decimal part
  int64_t ml = 0;
  if (!decode_flow_total_ml(n_bits, nf_bits, ml)) return false;
  instant_m3h = instant;
  total_ml = ml;
  return true;
}

// T3-1-2-H battery voltage (document register 0095) - V = reg * 2.5/4096,
// the manufacturer's own documented formula. A single register, so this
// isn't a word-order question the way the 32-bit values elsewhere in this
// file are.
inline bool read_flow_battery_voltage(UARTComponent *bus, uint8_t address, float &out, uint32_t timeout_ms = 200,
                                       bool *collision = nullptr) {
  const uint16_t REG = 94;  // document register "0095"
  uint16_t regs[1];
  bool contended = false;
  if (!read_holding_registers(bus, address, REG, 1, regs, 1, timeout_ms, &contended)) {
    ESP_LOGD(TAG, "address %d: battery voltage read failed%s", address, contended ? " (possible collision)" : "");
    if (collision) *collision = contended;
    return false;
  }
  if (collision) *collision = false;
  out = regs[0] * (2.5f / 4096.0f);
  return true;
}

// Is a device answering on `address` and naming that same address in its
// own address register? This is the ONLY trustworthy confirmation that an
// address change took effect, and both change_*_address() functions below
// verify through it rather than through the reply to the write itself.
//
// Why the write's own reply cannot be the check: a device that is
// changing its address mid-transaction may answer from the old address,
// from the new one, or not answer at all - all three happen, and none of
// them says whether the write landed. Trusting the write's own reply
// alone risks reporting a change as failed and reverting to the old
// address locally while the device has genuinely already switched,
// leaving the firmware polling an address the device just left - a worse
// outcome than either success or honest failure: the sensor is fine and
// unreachable at the same time.
//
// Retried, because a device that has just rewritten its own address is
// entitled to a moment before it answers again, and one slow reply here
// costs the same wrong answer as no reply at all.
inline bool address_confirmed(UARTComponent *bus, uint8_t address, uint16_t address_reg, uint32_t timeout_ms,
                              uint8_t attempts = 3) {
  for (uint8_t attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) esphome::delay(50);
    uint16_t readback[1];
    if (read_holding_registers(bus, address, address_reg, 1, readback, 1, timeout_ms) && readback[0] == address) {
      return true;
    }
  }
  return false;
}

inline bool change_address_and_save(UARTComponent *bus, uint8_t old_address, uint8_t new_address,
                                     uint32_t timeout_ms = 200) {
  // Deliberately unchecked - see address_confirmed() above. If it did not
  // land, the commit write below fails at the new address and the whole
  // thing reports failure anyway, which is the right answer for the right
  // reason.
  write_single_register(bus, old_address, 0, new_address, timeout_ms);
  esphome::delay(20);  // give the device a moment to actually switch over
  if (!write_single_register(bus, new_address, 15, 0, timeout_ms)) return false;
  esphome::delay(50);  // give the device a moment to finish its flash write
  return address_confirmed(bus, new_address, 0, timeout_ms);
}

// T3-1-2-H's own address-change procedure - genuinely different from the
// QDW90A's above, not a variant of it. Confirmed from the official
// Communication Protocol PDF: document register 0062 ("Main communication
// address", Integer, Writable, max 255) is a single, direct write - no
// second "commit to flash" register like the QDW90A's H:15=0 step.
// Reusing change_address_and_save() for Flow-type slots would write a
// QDW90A-style H:0/H:15 pair straight into this device's own live
// flow-rate and negative-accumulator registers instead of its address -
// see pressure_sensor.yaml's Modbus Address set_action for the guard
// that routes Flow-type slots here instead.
inline bool change_flow_address(UARTComponent *bus, uint8_t old_address, uint8_t new_address,
                                 uint32_t timeout_ms = 200) {
  const uint16_t PDU_ADDRESS_REG = 61;  // document register "0062"
  // Unchecked on purpose, and here it matters more than in the QDW90A
  // path above: this device's whole address change IS this one write, so
  // gating on its reply would record a device that switched without
  // echoing from its old address as never having switched at all - see
  // address_confirmed()'s own comment for why the reply can't be trusted.
  write_single_register(bus, old_address, PDU_ADDRESS_REG, new_address, timeout_ms);
  esphome::delay(50);  // give the device a moment to actually switch over
  return address_confirmed(bus, new_address, PDU_ADDRESS_REG, timeout_ms);
}

inline void update_scan_result_address(esphome::text_sensor::TextSensor *scan_results, uint8_t old_address,
                                        uint8_t new_address) {
  auto addresses = parse_address_csv(scan_results->state);
  addresses.erase(std::remove(addresses.begin(), addresses.end(), old_address), addresses.end());
  if (std::find(addresses.begin(), addresses.end(), new_address) == addresses.end()) {
    addresses.push_back(new_address);
  }
  scan_results->publish_state(join_address_csv(addresses));
}

inline void remove_scan_result_address(esphome::text_sensor::TextSensor *scan_results, uint8_t address) {
  auto addresses = parse_address_csv(scan_results->state);
  addresses.erase(std::remove(addresses.begin(), addresses.end(), address), addresses.end());
  scan_results->publish_state(join_address_csv(addresses));
}

inline bool set_scan_collision_address(esphome::text_sensor::TextSensor *scan_collisions, uint8_t address,
                                        bool present) {
  auto addresses = parse_address_csv(scan_collisions->state);
  bool already_present = std::find(addresses.begin(), addresses.end(), address) != addresses.end();
  if (present == already_present) return false;  // no change - skip the publish_state()/SSE update entirely
  if (present) {
    addresses.push_back(address);
  } else {
    addresses.erase(std::remove(addresses.begin(), addresses.end(), address), addresses.end());
  }
  scan_collisions->publish_state(join_address_csv(addresses));
  return true;
}

inline void set_scan_mismatch_address(esphome::text_sensor::TextSensor *scan_mismatches, uint8_t address,
                                       bool present) {
  auto addresses = parse_address_csv(scan_mismatches->state);
  bool already_present = std::find(addresses.begin(), addresses.end(), address) != addresses.end();
  if (present == already_present) return;
  if (present) {
    addresses.push_back(address);
  } else {
    addresses.erase(std::remove(addresses.begin(), addresses.end(), address), addresses.end());
  }
  scan_mismatches->publish_state(join_address_csv(addresses));
}

// What one slot remembers about its link between identity checks - the
// evidence the Collision verdict has to answer to. One instance per slot
// (slot_link() below), reset whenever the slot changes address or is
// deleted.
//
// Two rules:
//
//  - Silence refutes a collision. Without this, a meter unplugged from a
//    live bus keeps its Collision badge instead of going Lost: its last
//    frame as it was pulled arrives damaged, the poll files that as a
//    collision, and nothing can ever take the flag down again, since the
//    only thing allowed to (the identity check) runs on good polls, and
//    there are no more of those. "Collision" means two devices answer
//    here; an address answering with nothing at all, poll after poll,
//    has no devices on it. Note: nothing, not garbage - two devices
//    clashing so badly that no frame survives still puts bytes on the
//    wire, and those keep the flag.
//
//  - One clean fingerprint does not outweigh damaged replies. Two
//    identical devices on one address answer the fingerprint reads
//    identically, so the identity check alone would see one healthy
//    device and clear the flag every ten seconds, while polls in between
//    keep catching the replies colliding - the badge would flash OK once
//    per check. The check may only clear the flag once it has come back
//    clean twice in a row AND no poll has seen a damaged reply for a
//    whole identity period. Same for a pressure sensor and a flow meter
//    sharing an address: their fingerprint reads collide only most of
//    the time, and the odd clean sample would otherwise reset the
//    verdict.
struct SlotLinkState {
  uint32_t last_collision_ms = 0;
  bool collision_seen = false;
  uint8_t silent_polls = 0;
  uint8_t clean_identity_checks = 0;
};

// The per-slot instances, looked up by the slot's id prefix ("slot1" and
// so on, packages/pressure_sensor.yaml). Not an ESPHome global: the
// generated main.cpp declares every global before it includes this
// header, so a global of a type declared here does not compile
// ("'rs485_modbus' was not declared in this scope" on the globals
// block). The keys are the string literals the package substitutes in,
// so they are compared by content, not by address. Four slots plus
// headroom; a key past the table shares the last entry rather than
// writing out of bounds.
inline SlotLinkState &slot_link(const char *key) {
  static constexpr size_t MAX_LINKS = 8;
  struct Entry {
    const char *key;
    SlotLinkState state;
  };
  static Entry links[MAX_LINKS] = {};
  for (size_t i = 0; i < MAX_LINKS; i++) {
    if (links[i].key == nullptr) {
      links[i].key = key;
      return links[i].state;
    }
    if (std::strcmp(links[i].key, key) == 0) return links[i].state;
  }
  return links[MAX_LINKS - 1].state;
}

// Consecutive polls that came back with nothing on the wire before the
// address is taken to be empty and its Collision (and identity) verdicts
// withdrawn. Matches the streak that withdraws the reading and flips the
// Online badge, so the three cannot disagree.
static constexpr uint8_t SILENT_POLLS_TO_CLEAR = 3;

// Clean identity checks in a row before the check is trusted to clear a
// Collision it did not raise itself.
static constexpr uint8_t CLEAN_CHECKS_TO_CLEAR = 2;

// Called with every poll result. Returns true when this poll completed a
// run of SILENT_POLLS_TO_CLEAR silent polls, i.e. the address should now
// be treated as empty.
inline bool note_poll(SlotLinkState &link, TxResult result, uint32_t now_ms) {
  if (result == TxResult::COLLISION) {
    link.collision_seen = true;
    link.last_collision_ms = now_ms;
    // A live poll proving a collision RIGHT NOW invalidates any clean
    // identity checks counted before it - "clean twice in a row" has to
    // mean twice after the last proof of contention, not twice ever with
    // a fresh collision merely straddled in between uncounted. Real risk
    // this closes: two clean checks recorded long ago, unrelated to a
    // collision that starts now, would otherwise only need ONE clean
    // check after this collision subsides to satisfy "twice" and clear
    // the flag - one real sample away from the exact flicker this
    // counter exists to prevent.
    link.clean_identity_checks = 0;
  }
  if (result == TxResult::TIMEOUT) {
    if (link.silent_polls < 255) link.silent_polls++;
    return link.silent_polls == SILENT_POLLS_TO_CLEAR;
  }
  link.silent_polls = 0;
  return false;
}

// Called with every identity check's verdict. Returns true only when the
// check is entitled to clear the Collision flag: not conflicting, clean
// CLEAN_CHECKS_TO_CLEAR times in a row, and no damaged reply from a poll
// within the last period_ms. A check that reached no verdict at all
// (`known` false: neither fingerprint answered, a busy moment on the
// bus) is not a clean sample - it neither counts toward clearing nor
// resets the count.
inline bool identity_may_clear_collision(SlotLinkState &link, bool conflicting, bool known, uint32_t now_ms,
                                         uint32_t period_ms) {
  if (conflicting) {
    link.clean_identity_checks = 0;
    return false;
  }
  if (!known) return false;
  if (link.clean_identity_checks < 255) link.clean_identity_checks++;
  if (link.clean_identity_checks < CLEAN_CHECKS_TO_CLEAR) return false;
  if (link.collision_seen && (uint32_t) (now_ms - link.last_collision_ms) < period_ms) return false;
  return true;
}

// What a poll may say about the Mismatch flag. Two witnesses, neither of
// which may overrule the other:
//
//  - this poll's own bytes: the device answered, but its registers do
//    not decode as the configured type (a T3 read as a pressure block
//    comes back the wrong length; a QDW90A read as a flow block does
//    too). Visible on every poll, so re-derived on every poll.
//  - the identity check: the registers decode fine but the device says
//    it is the other instrument (a swapped flow meter reading as a
//    healthy 0.00 bar). Only visible once every identity period, so it
//    has to be REMEMBERED between checks - otherwise the very next poll,
//    which cannot see it, would recompute "decodes fine, no mismatch"
//    and take the badge straight back down, flashing once per identity
//    period and reading as a glitch.
//
// A collision takes precedence: registers read through a contended
// address say nothing about which device they came from.
inline bool poll_mismatch(bool device_responded, bool ok, bool collision, bool identity_mismatch) {
  if (collision) return false;
  return (device_responded && !ok) || identity_mismatch;
}

inline bool publish_poll_result(esphome::binary_sensor::BinarySensor *online,
                                 esphome::text_sensor::TextSensor *scan_collisions,
                                 esphome::text_sensor::TextSensor *scan_mismatches, uint8_t address, bool ok,
                                 bool collision, bool reachable, bool device_responded, bool identity_mismatch) {
  // Only on an actual change: at three polls a second per device this
  // would otherwise be a state push per poll per slot, forever, carrying
  // the same "still online" it carried a third of a second ago. Same
  // reasoning as volume::publish_if_changed() (include/volume.h) - kept
  // inline here so this header stays independent of that one.
  if (!online->has_state() || online->state != reachable) online->publish_state(reachable);
  // Sets the Collision flag, never clears it.
  //
  // The measurement poll cannot tell one device from two: two different
  // instruments on one address can both answer a read with the same
  // payload, so every frame is valid and the poll sees a healthy sensor.
  // Clearing the flag on any successful poll would wipe out a collision
  // found by something that CAN see it - the bus scan, or the identity
  // check - on the very next ordinary reading: the badge would flash red
  // and go back to OK, reading as "it was nothing".
  //
  // So clearing belongs to whoever can actually establish the address is
  // singly occupied, and that is the identity check in each slot's
  // _poll_finish (packages/pressure_sensor.yaml) and a fresh scan.
  bool collision_changed = collision && set_scan_collision_address(scan_collisions, address, true);
  set_scan_mismatch_address(scan_mismatches, address, poll_mismatch(device_responded, ok, collision, identity_mismatch));
  return collision_changed;
}

}  // namespace rs485_modbus
