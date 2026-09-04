// Host-side tests for the two firmware headers that carry all the logic
// this project cannot afford to get wrong: the Modbus wire protocol
// (include/rs485_modbus.h) and volume bookkeeping (include/volume.h).
//
// Why these exist at all: the real firmware only ever compiles inside
// ESP-IDF, which means the ONLY check that ran on this code before was
// "esphome config" - a YAML validity check that never compiles a single
// line of C++, let alone executes it. Every bug in the list this suite
// was written for (a 0x06 write accepted on the strength of its function
// code alone, a float total that lost the millilitres it claimed to
// report, a Reading applied against a raw reading that had never been
// taken) is the kind that a few dozen lines of host-side test would have
// caught the day it was written.
//
// The ESPHome headers these files include are stubbed in tests/stubs -
// just enough surface to compile and to let a test drive a fake UART and
// read back what was published. Nothing in include/ is modified or
// re-declared for the tests; they compile the real headers.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "volume.h"
#include "rs485_modbus.h"

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                             \
  do {                                                                          \
    checks++;                                                                   \
    if (!(cond)) {                                                              \
      failures++;                                                               \
      printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                  \
    }                                                                           \
  } while (0)

#define CHECK_EQ_I64(actual, expected)                                          \
  do {                                                                          \
    checks++;                                                                   \
    long long a_ = (long long) (actual);                                        \
    long long e_ = (long long) (expected);                                      \
    if (a_ != e_) {                                                             \
      failures++;                                                               \
      printf("  FAIL %s:%d: %s == %lld, expected %lld\n", __FILE__, __LINE__,   \
             #actual, a_, e_);                                                  \
    }                                                                           \
  } while (0)

#define CHECK_EQ_STR(actual, expected)                                          \
  do {                                                                          \
    checks++;                                                                   \
    std::string a_ = (actual);                                                  \
    std::string e_ = (expected);                                                \
    if (a_ != e_) {                                                             \
      failures++;                                                               \
      printf("  FAIL %s:%d: %s == \"%s\", expected \"%s\"\n", __FILE__,         \
             __LINE__, #actual, a_.c_str(), e_.c_str());                        \
    }                                                                           \
  } while (0)

using esphome::uart::UARTComponent;

// --- helpers -------------------------------------------------------------

static std::vector<uint8_t> with_crc(std::vector<uint8_t> frame) {
  uint16_t crc = rs485_modbus::crc16(frame.data(), frame.size());
  frame.push_back(static_cast<uint8_t>(crc & 0xFF));
  frame.push_back(static_cast<uint8_t>((crc >> 8) & 0xFF));
  return frame;
}

// A 0x03 read reply carrying `regs`, big-endian per register, CRC appended.
static std::vector<uint8_t> read_reply(uint8_t address, const std::vector<uint16_t> &regs) {
  std::vector<uint8_t> frame{address, 0x03, static_cast<uint8_t>(regs.size() * 2)};
  for (uint16_t r : regs) {
    frame.push_back(static_cast<uint8_t>(r >> 8));
    frame.push_back(static_cast<uint8_t>(r & 0xFF));
  }
  return with_crc(frame);
}

static void float_to_regs_low_word_first(float value, uint16_t &low, uint16_t &high) {
  uint32_t bits;
  std::memcpy(&bits, &value, sizeof(bits));
  low = static_cast<uint16_t>(bits & 0xFFFF);
  high = static_cast<uint16_t>(bits >> 16);
}


// --- the non-blocking state machine ----------------------------------------
// The property that matters is not just "it decodes a reply" (the
// blocking version did that too) but that it NEVER waits. The stub HAL
// only advances its clock inside yield()/delay(), so asserting that
// esphome::test_millis is unchanged across a poll() is a direct,
// mechanical check that nothing in the state machine blocks.

static void feed(UARTComponent &bus, const std::vector<uint8_t> &bytes, size_t from, size_t count) {
  for (size_t i = from; i < from + count && i < bytes.size(); i++) bus.rx.push_back(bytes[i]);
}

static void test_transaction_never_blocks() {
  printf("Transaction: never blocks\n");
  UARTComponent bus;
  rs485_modbus::Transaction tx;
  auto reply = read_reply(1, {0x0011, 0x0022});

  CHECK(tx.idle());
  CHECK(tx.start_read(&bus, 1, 22, 2, 60));
  CHECK(tx.busy());
  // A second request while one is in flight is refused, not queued - the
  // bus is a single resource and the scheduler owns it.
  CHECK(!tx.start_read(&bus, 2, 22, 2, 60));

  uint32_t before = esphome::test_millis;
  for (int i = 0; i < 50; i++) tx.poll(&bus);  // nothing has arrived yet
  CHECK_EQ_I64(esphome::test_millis, before);  // ...and not one tick was spent waiting
  CHECK(tx.busy());

  // Bytes trickle in the way a 9600-baud reply actually arrives, a few
  // at a time across many ticks.
  feed(bus, reply, 0, 3);
  tx.poll(&bus);
  CHECK(tx.busy());  // header seen, body still outstanding
  for (size_t i = 3; i < reply.size(); i++) {
    feed(bus, reply, i, 1);
    tx.poll(&bus);
  }
  CHECK(tx.done());
  CHECK_EQ_I64(esphome::test_millis, before);  // still not a single blocking tick

  uint16_t out[2] = {0, 0};
  size_t received = 0;
  CHECK(tx.take(out, 2, &received) == rs485_modbus::TxResult::OK);
  CHECK_EQ_I64(received, 2);
  CHECK_EQ_I64(out[0], 0x0011);
  CHECK_EQ_I64(out[1], 0x0022);
  CHECK(tx.idle());  // and the bus is free again for the next slot
}

static void test_transaction_timeout() {
  printf("Transaction: timeout and partial reply\n");
  {
    // Nothing answers at all.
    UARTComponent bus;
    rs485_modbus::Transaction tx;
    CHECK(tx.start_read(&bus, 9, 0, 2, 60));
    tx.poll(&bus);
    CHECK(tx.busy());
    esphome::test_millis += 59;
    tx.poll(&bus);
    CHECK(tx.busy());  // not one millisecond early
    esphome::test_millis += 1;
    tx.poll(&bus);
    CHECK(tx.done());
    CHECK(tx.take(nullptr, 0, nullptr) == rs485_modbus::TxResult::TIMEOUT);
  }
  {
    // A reply starts and then stops - that is not silence, it is a
    // damaged/contended frame, and the two must stay distinguishable
    // (one means "nothing there", the other "possible collision").
    UARTComponent bus;
    rs485_modbus::Transaction tx;
    auto reply = read_reply(9, {0x0001, 0x0002});
    CHECK(tx.start_read(&bus, 9, 0, 2, 60));
    feed(bus, reply, 0, 4);
    tx.poll(&bus);
    CHECK(tx.busy());
    esphome::test_millis += 61;
    tx.poll(&bus);
    CHECK(tx.done());
    CHECK(tx.take(nullptr, 0, nullptr) == rs485_modbus::TxResult::BAD_FRAME);
  }
  {
    // The body gets its own timeout window, measured from when the
    // header arrived - a slow but complete reply must not be thrown away
    // just because the header took a while.
    UARTComponent bus;
    rs485_modbus::Transaction tx;
    auto reply = read_reply(9, {0x0001, 0x0002});
    CHECK(tx.start_read(&bus, 9, 0, 2, 60));
    esphome::test_millis += 50;
    feed(bus, reply, 0, 3);
    tx.poll(&bus);
    esphome::test_millis += 50;  // past the original window, inside the body's own
    feed(bus, reply, 3, reply.size() - 3);
    tx.poll(&bus);
    CHECK(tx.done());
    CHECK(tx.take(nullptr, 0, nullptr) == rs485_modbus::TxResult::OK);
  }
}

static void test_transaction_outcomes() {
  printf("Transaction: outcome classification\n");
  struct Case {
    const char *what;
    std::vector<uint8_t> reply;
    rs485_modbus::TxResult expected;
  };
  auto bad_crc = read_reply(4, {0x0001, 0x0002});
  bad_crc[bad_crc.size() - 1] ^= 0xFF;
  // Noise off a floating conductor: nine bytes that are not an answer to
  // anything. Whatever the CRC happens to come out as, the address is
  // not ours, so this can never be evidence of a collision.
  std::vector<uint8_t> line_noise = {0xFF, 0x7E, 0xA3, 0x00, 0x11, 0x5C, 0x9D, 0x02, 0xE7};
  // Noise that does start with our address - the case a one-byte test
  // would misread. On a broken line this turns up every few minutes.
  auto noise_at_our_address = line_noise;
  noise_at_our_address[0] = 4;
  // Right address and function, but claiming a different payload size
  // than the answer to our request would have.
  std::vector<uint8_t> wrong_size_bad_crc = {4, 0x03, 0x06, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03};
  // Two identical devices answering a fraction of a bit apart: the
  // receiver sees the AND of the two replies, which eats the header
  // bytes while the tail - CRC included - comes through intact. The
  // header test alone calls this noise; the CRC says it is our reply.
  auto damaged_header = read_reply(4, {0x0000, 0x0000});
  damaged_header[0] = 0x00;
  damaged_header[1] = 0x02;
  damaged_header[2] = 0x00;
  // The same superposition when the CRC bytes were hit as well - then
  // nothing ties the frame to our request any more.
  auto damaged_header_and_crc = damaged_header;
  damaged_header_and_crc[damaged_header_and_crc.size() - 1] ^= 0x01;
  Case cases[] = {
      {"clean read", read_reply(4, {0x0001, 0x0002}), rs485_modbus::TxResult::OK},
      {"exception", with_crc({4, 0x83, 0x02}), rs485_modbus::TxResult::EXCEPTION},
      // Our own reply, damaged: the one shape that means two devices
      // answered at once - they build identical headers and differ only
      // in the register values.
      {"our reply, damaged", bad_crc, rs485_modbus::TxResult::COLLISION},
      {"line noise", line_noise, rs485_modbus::TxResult::BAD_FRAME},
      {"line noise carrying our address", noise_at_our_address, rs485_modbus::TxResult::BAD_FRAME},
      {"damaged frame of the wrong size", wrong_size_bad_crc, rs485_modbus::TxResult::BAD_FRAME},
      {"our reply with a damaged header, CRC intact", damaged_header, rs485_modbus::TxResult::COLLISION},
      {"damaged header and damaged CRC", damaged_header_and_crc, rs485_modbus::TxResult::BAD_FRAME},
      {"wrong address", read_reply(7, {0x0001, 0x0002}), rs485_modbus::TxResult::BAD_FRAME},
      {"wrong byte count", with_crc({4, 0x03, 0x02, 0x00, 0x01, 0x00, 0x02}), rs485_modbus::TxResult::BAD_FRAME},
  };
  for (const auto &c : cases) {
    UARTComponent bus;
    rs485_modbus::Transaction tx;
    CHECK(tx.start_read(&bus, 4, 0, 2, 60));
    for (uint8_t b : c.reply) bus.rx.push_back(b);
    for (int i = 0; i < 4 && !tx.done(); i++) tx.poll(&bus);
    checks++;
    auto got = tx.take(nullptr, 0, nullptr);
    if (got != c.expected) {
      failures++;
      printf("  FAIL %s: got result %d, expected %d\n", c.what, (int) got, (int) c.expected);
    }
  }
}


// --- handing the bus from the poll to a one-shot ---------------------------
// The background poll owns a shared Transaction; the button-press
// operations (bus scan, address change, battery read) block on their own.
// The two collide at the boundary, and getting that wrong broke the
// address change outright - see drain_poll_transaction()'s own comment.

static void test_one_shot_takes_the_bus() {
  printf("bus handover: one-shot vs background poll\n");
  auto &poll = rs485_modbus::poll_transaction();
  {
    // The poll's reply has landed; drain must consume it and clear the
    // wire, not leave bytes behind for the next request to trip over.
    poll.reset();
    UARTComponent bus;
    CHECK(poll.start_read(&bus, 1, rs485_modbus::FLOW_BLOCK_START_REG, rs485_modbus::FLOW_BLOCK_REGISTERS, 60));
    CHECK(poll.busy());
    for (uint8_t b : read_reply(1, std::vector<uint16_t>(rs485_modbus::FLOW_BLOCK_REGISTERS, 0))) bus.rx.push_back(b);
    rs485_modbus::drain_poll_transaction(&bus);
    CHECK(poll.idle());
    CHECK_EQ_I64(bus.rx.size(), 0);
  }
  {
    // Nothing ever answers the poll: drain still has to hand the bus over
    // rather than wedge on a transaction that will never complete.
    poll.reset();
    UARTComponent bus;
    CHECK(poll.start_read(&bus, 1, 0, 2, 60));
    rs485_modbus::drain_poll_transaction(&bus);
    CHECK(poll.idle());
  }
  {
    // The real failure: a 0x06 write issued while a poll is outstanding.
    // Without the handover the write puts a second request on a bus that
    // still owes an answer, and reads the poll's 12-register reply where
    // it expected an 8-byte echo - which is exactly why changing a
    // registered slot's Modbus address failed every time.
    poll.reset();
    UARTComponent bus;
    CHECK(poll.start_read(&bus, 1, rs485_modbus::FLOW_BLOCK_START_REG, rs485_modbus::FLOW_BLOCK_REGISTERS, 60));
    bus.replies.push_back(with_crc({1, 0x06, 0x00, 0x3D, 0x00, 0x09}));
    CHECK(rs485_modbus::write_single_register(&bus, 1, 61, 9, 60));
    CHECK(poll.idle());
  }
  {
    // Same for a blocking read (the battery voltage a row opening fires).
    poll.reset();
    UARTComponent bus;
    CHECK(poll.start_read(&bus, 1, rs485_modbus::FLOW_BLOCK_START_REG, rs485_modbus::FLOW_BLOCK_REGISTERS, 60));
    bus.replies.push_back(read_reply(1, {0x0BB8}));
    uint16_t out[1] = {0};
    CHECK(rs485_modbus::read_holding_registers(&bus, 1, 94, 1, out, 1, 60));
    CHECK_EQ_I64(out[0], 0x0BB8);
    CHECK(poll.idle());
  }
  poll.reset();
}

// --- CRC ------------------------------------------------------------------

// The wire-level trace is off by default and must build its hex dumps
// only when it isn't - see rs485_modbus::trace_enabled_flag(), and the
// note there on why this is a flag of our own rather than a question for
// the logger. (That this file links at all is the other half of the
// check: tests/stubs' Logger declares level_for() without a definition,
// exactly as the real one does, so any code that goes back to asking the
// logger fails here instead of on the device.)
static void test_trace_flag() {
  printf("trace flag\n");
  CHECK(!rs485_modbus::trace_enabled());
  test_log::lines.clear();
  UARTComponent bus;
  bus.replies.push_back(read_reply(1, {0x0001}));
  uint16_t out[1];
  CHECK(rs485_modbus::read_holding_registers(&bus, 1, 0, 1, out, 1, 50));
  CHECK_EQ_I64(test_log::lines.size(), 0);  // a clean read logs nothing at all with tracing off

  rs485_modbus::trace_enabled_flag() = true;
  UARTComponent traced;
  traced.replies.push_back(read_reply(1, {0x0001}));
  CHECK(rs485_modbus::read_holding_registers(&traced, 1, 0, 1, out, 1, 50));
  CHECK(test_log::lines.size() >= 2);  // request and reply dumps
  rs485_modbus::trace_enabled_flag() = false;
  test_log::lines.clear();
}

static void test_crc16() {
  printf("crc16\n");
  // The canonical Modbus RTU example frame: read 1 holding register at 0
  // from address 1 is "01 03 00 00 00 01 84 0A" - low CRC byte first on
  // the wire, which is the order transact() appends them in.
  const uint8_t request[] = {0x01, 0x03, 0x00, 0x00, 0x00, 0x01};
  uint16_t crc = rs485_modbus::crc16(request, sizeof(request));
  CHECK_EQ_I64(crc & 0xFF, 0x84);
  CHECK_EQ_I64((crc >> 8) & 0xFF, 0x0A);
  // An empty buffer is the init value, untouched.
  CHECK_EQ_I64(rs485_modbus::crc16(request, 0), 0xFFFF);
}

// --- transaction framing ---------------------------------------------------

static void test_read_holding_registers() {
  printf("read_holding_registers\n");
  {
    UARTComponent bus;
    bus.replies.push_back(read_reply(3, {0x1234, 0xABCD}));
    uint16_t out[2] = {0, 0};
    bool ok = rs485_modbus::read_holding_registers(&bus, 3, 22, 2, out, 2, 50);
    CHECK(ok);
    CHECK_EQ_I64(out[0], 0x1234);
    CHECK_EQ_I64(out[1], 0xABCD);
    // Request framing: address, function, start register, count, CRC.
    CHECK_EQ_I64(bus.tx.size(), 8);
    CHECK_EQ_I64(bus.tx[0], 3);
    CHECK_EQ_I64(bus.tx[1], 0x03);
    CHECK_EQ_I64(bus.tx[3], 22);
    CHECK_EQ_I64(bus.tx[5], 2);
  }
  {
    // A corrupted CRC must be refused, not decoded.
    UARTComponent bus;
    auto reply = read_reply(3, {0x1234, 0xABCD});
    reply[reply.size() - 1] ^= 0xFF;
    bus.replies.push_back(reply);
    uint16_t out[2] = {0, 0};
    CHECK(!rs485_modbus::read_holding_registers(&bus, 3, 22, 2, out, 2, 50));
  }
  {
    // A reply from a different address is bus noise, not our data.
    UARTComponent bus;
    bus.replies.push_back(read_reply(9, {0x1234, 0xABCD}));
    uint16_t out[2] = {0, 0};
    CHECK(!rs485_modbus::read_holding_registers(&bus, 3, 22, 2, out, 2, 50));
  }
  {
    // A Modbus exception proves the device is there but this register
    // isn't readable - not a timeout, and the collision flag must NOT be
    // set: the device answered perfectly well, it just refused.
    UARTComponent bus;
    bus.replies.push_back(with_crc({3, 0x83, 0x02}));
    uint16_t out[2] = {0, 0};
    bool collision = true;
    bool responded = false;
    CHECK(!rs485_modbus::read_holding_registers(&bus, 3, 22, 2, out, 2, 50, &collision, &responded));
    CHECK(!collision);
    CHECK(responded);
  }
  {
    // Silence.
    UARTComponent bus;
    uint16_t out[2] = {0, 0};
    bool collision = true;
    CHECK(!rs485_modbus::read_holding_registers(&bus, 3, 22, 2, out, 2, 20, &collision));
    CHECK(!collision);
  }
  {
    // A broken/floating conductor: the receiver picks noise out of the
    // air, so a frame-sized run of bytes arrives that answers nothing.
    // This must read as "no usable reply" - the dashboard turns the
    // collision flag into a "Collision?" badge, and reporting an address
    // clash for what is really a wiring fault sends the next person
    // looking in the wrong place.
    UARTComponent bus;
    bus.replies.push_back({0xFF, 0x7E, 0xA3, 0x00, 0x11, 0x5C, 0x9D, 0x02, 0xE7});
    uint16_t out[2] = {0, 0};
    bool collision = true;
    bool responded = true;
    CHECK(!rs485_modbus::read_holding_registers(&bus, 3, 22, 2, out, 2, 50, &collision, &responded));
    CHECK(!collision);
    CHECK(!responded);
  }
  {
    // Two devices on one address, answering the same request over each
    // other: identical headers, differing payloads, so what comes back is
    // our own reply with a failed CRC. THIS is a collision, and it has to
    // stay distinguishable from the noise above.
    UARTComponent bus;
    auto contended = read_reply(3, {0x1234, 0xABCD});
    contended[5] ^= 0x5A;  // a payload byte from the other device
    bus.replies.push_back(contended);
    uint16_t out[2] = {0, 0};
    bool collision = false;
    bool responded = true;
    CHECK(!rs485_modbus::read_holding_registers(&bus, 3, 22, 2, out, 2, 50, &collision, &responded));
    CHECK(collision);
    CHECK(!responded);
  }
  {
    // A caller asking for more registers than the reply buffer can hold
    // must be refused outright rather than overrunning it.
    UARTComponent bus;
    uint16_t out[2] = {0, 0};
    CHECK(!rs485_modbus::read_holding_registers(&bus, 3, 0, 2, out, 1, 20));
    CHECK(!rs485_modbus::read_holding_registers(&bus, 3, 0, 21, out, 2, 20));
    CHECK_EQ_I64(bus.tx.size(), 0);  // nothing was even sent
  }
}

static void test_write_single_register_verifies_echo() {
  printf("write_single_register\n");
  {
    UARTComponent bus;
    bus.replies.push_back(with_crc({7, 0x06, 0x00, 0x3D, 0x00, 0x09}));
    CHECK(rs485_modbus::write_single_register(&bus, 7, 61, 9, 50));
  }
  {
    // Same function code, DIFFERENT register echoed back. This used to
    // pass: the check was `reply[1] == 0x06` and nothing else, so a
    // device that acknowledged some other register (or a stale frame
    // still in the buffer) counted as a successful write - which for the
    // address-change path means reporting a device moved when it hadn't.
    UARTComponent bus;
    bus.replies.push_back(with_crc({7, 0x06, 0x00, 0x00, 0x00, 0x09}));
    CHECK(!rs485_modbus::write_single_register(&bus, 7, 61, 9, 50));
  }
  {
    // Same register, different value.
    UARTComponent bus;
    bus.replies.push_back(with_crc({7, 0x06, 0x00, 0x3D, 0x00, 0x08}));
    CHECK(!rs485_modbus::write_single_register(&bus, 7, 61, 9, 50));
  }
  {
    // An exception reply is a refusal, not a write.
    UARTComponent bus;
    bus.replies.push_back(with_crc({7, 0x86, 0x02}));
    CHECK(!rs485_modbus::write_single_register(&bus, 7, 61, 9, 50));
  }
}

// An address change is the one write whose own reply proves nothing: the
// device is changing the address it answers on while it answers. What
// decides the outcome is whether the new address is live afterwards.
static void test_address_change_is_verified_by_readback() {
  printf("address change verification\n");
  {
    // The write is not acknowledged at all - the device switched over
    // without echoing from the address it was leaving. Without a readback
    // this case can be misreported as "not moved", leaving the firmware
    // polling the old address for a device that is fine and unreachable
    // at once.
    UARTComponent bus;
    bus.replies.push_back({});                                            // the write: silence
    bus.replies.push_back(with_crc({101, 0x03, 0x02, 0x00, 101}));        // reg 0062 at the new address
    CHECK(rs485_modbus::change_flow_address(&bus, 100, 101, 50));
  }
  {
    // The device never moved: nothing answers at the new address.
    UARTComponent bus;
    bus.replies.push_back(with_crc({100, 0x06, 0x00, 0x3D, 0x00, 101}));  // a perfect echo...
    for (int i = 0; i < 3; i++) bus.replies.push_back({});                // ...and silence at 101
    CHECK(!rs485_modbus::change_flow_address(&bus, 100, 101, 50));
  }
  {
    // Something answers at the new address but names a different one -
    // another device, not ours. Not a confirmation.
    UARTComponent bus;
    bus.replies.push_back({});
    for (int i = 0; i < 3; i++) bus.replies.push_back(with_crc({101, 0x03, 0x02, 0x00, 55}));
    CHECK(!rs485_modbus::change_flow_address(&bus, 100, 101, 50));
  }
  {
    // A device entitled to a moment: the first read after the switch goes
    // unanswered, the next one confirms. One slow reply must not cost the
    // same wrong answer as no reply at all.
    UARTComponent bus;
    bus.replies.push_back({});                                      // the write
    bus.replies.push_back({});                                      // first confirmation attempt: too early
    bus.replies.push_back(with_crc({101, 0x03, 0x02, 0x00, 101}));  // second: there it is
    CHECK(rs485_modbus::change_flow_address(&bus, 100, 101, 50));
  }
}

static void test_address_change_authorization_is_exact_and_one_shot() {
  printf("address change authorization: exact, expiring and non-replayable\n");
  rs485_modbus::AddressChangeAuthorization authorization;

  CHECK(authorization.arm(1, 33, 1001, 100));
  CHECK(!authorization.consume(1, 34, 101));  // wrong destination consumes no authority
  CHECK(!authorization.consume(1, 33, 102));  // and the failed attempt cleared the arm

  CHECK(authorization.arm(1, 33, 1001, 200));
  CHECK(authorization.consume(1, 33, 201));
  CHECK(!authorization.consume(1, 33, 202));  // one use only
  CHECK(!authorization.arm(1, 33, 1001, 203));  // the complete command cannot be replayed

  CHECK(authorization.arm(1, 33, 1002, 300, 5));
  CHECK(!authorization.consume(1, 33, 306));  // expired
  CHECK(!authorization.arm(0, 33, 1003, 400));
  CHECK(!authorization.arm(33, 33, 1004, 400));
  CHECK(!authorization.arm(1, 33, 0, 400));
}

// The exact real-hardware scenario this class exists to prevent, spelled
// out end to end: a device at address 1 is deliberately moved to 33 -
// one dashboard action, one arm()+consume() pair. Sometime later,
// someone disconnects that device (now happily living at 33) and
// connects a DIFFERENT, unrelated device that happens to power up at
// address 1 - the same address the first device used to occupy. Nothing
// about that - not a scan, not the slot's own live polling, not the new
// device announcing itself - ever calls arm() again. Without a fresh,
// explicit dashboard action there is no authorization to consume, at any
// later time, no matter how exactly the old/new pair matches: the
// address is not what is authorized, one specific TRANSITION is, and it
// was already spent.
static void test_address_change_authorization_does_not_infect_a_later_device_at_the_old_address() {
  printf(
      "address change authorization: a different device appearing later at the OLD address is never silently "
      "reprogrammed\n");
  rs485_modbus::AddressChangeAuthorization authorization;
  CHECK(authorization.arm(1, 33, 555, 0));
  CHECK(authorization.consume(1, 33, 10));  // device A: 1 -> 33, done
  // Ten minutes later - long past any plausible request lifetime - a
  // second, unrelated device answers at address 1.
  uint32_t much_later_ms = 10 * 60 * 1000;
  CHECK(!authorization.consume(1, 33, much_later_ms));   // no standing authority to replay onto it
  CHECK(!authorization.arm(1, 33, 555, much_later_ms));  // nor can the original nonce reopen the window
}

// AddressInspector/inspect_address_blocking() replaced probe()+identify()
// as the one evidence machine Add, address-change and the scan all share
// (see the class's own comment in rs485_modbus.h for the full sequence
// and why each step exists). These tests drive it through
// inspect_address_blocking() - the scan's own non-blocking use of the
// SAME state machine is tested separately below, against a UART mock
// that delivers replies on a genuine, staged timeline rather than handing
// over a complete answer the instant a request goes out.
static void test_address_inspection_single_device() {
  printf("AddressInspector: a single, healthy device\n");
  {
    // Address 10, Pressure - probes clean, no flow self-test, its own
    // QDW90A identity block, then eight clean confirmation reads of the
    // pressure block. Nothing here should ever read as contended.
    UARTComponent bus;
    for (int i = 0; i < 2; i++) bus.replies.push_back(read_reply(10, {0x000A}));  // PROBE_1, PROBE_2
    bus.replies.push_back({});                                                   // FP_FLOW: no self-test
    bus.replies.push_back(read_reply(10, {0x000A, 0x0003, 0x0003, 0x0002}));      // FP_PRESSURE: QDW90A block
    for (int i = 0; i < rs485_modbus::ADDRESS_INSPECTOR_CONFIRM_READS; i++) {
      bus.replies.push_back(read_reply(10, {0x0000, 0x0000}));  // CONFIRM x N: pressure block, 0.00 bar
    }
    auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
    CHECK(inspector.verdict() == rs485_modbus::AddressObservation::VALID_RESPONSE);
    CHECK(inspector.kind() == rs485_modbus::DeviceKind::PRESSURE);
  }
  {
    // Nothing there at all - one probe, silence, done. The cheapest case
    // has to stay cheap: 247 addresses at up to a dozen reads each would
    // undo the whole point of the confirmation reads.
    UARTComponent bus;
    auto inspector = rs485_modbus::inspect_address_blocking(&bus, 11, 20);
    CHECK(inspector.verdict() == rs485_modbus::AddressObservation::SILENCE);
    checks++;
    if (bus.tx.size() != 8) {  // exactly one 8-byte request
      failures++;
      printf("  FAIL a silent address should cost exactly one request, sent %zu bytes\n", bus.tx.size());
    }
  }
}

static void test_silent_fingerprint_does_not_open_a_tail_window() {
  printf("AddressInspector: a silent optional fingerprint has no reply tail to reserve\n");
  esphome::test_millis = 0;
  UARTComponent bus;
  bus.replies.push_back(read_reply(10, {0x000A}));
  bus.replies.push_back(read_reply(10, {0x000A}));
  bus.replies.push_back({});  // pressure devices normally ignore FLOW_SELFTEST_REG
  rs485_modbus::AddressInspector inspector;
  rs485_modbus::Transaction tx;
  inspector.start(10, 20);
  bool consumed_silence = false;
  for (int i = 0; i < 300 && !consumed_silence; i++) {
    uint32_t before = esphome::test_millis;
    inspector.step(&bus, tx);
    CHECK_EQ_I64(esphome::test_millis, before);
    consumed_silence = bus.tx.size() == 24 && tx.idle();
    if (!consumed_silence) esphome::delay(1);
  }
  CHECK(consumed_silence);
  CHECK(!inspector.requires_bus_exclusive());
}

static void test_periodic_identity_inspector_never_blocks() {
  printf("IdentityInspector: periodic fingerprints are non-blocking and reserve their tail window\n");
  esphome::test_millis = 0;
  UARTComponent bus;
  uint16_t low = 0, high = 0;
  float_to_regs_low_word_first(361.0f, low, high);
  bus.replies.push_back(read_reply(10, {low, high}));  // Flow fingerprint
  bus.replies.push_back({});                           // Pressure fingerprint: expected NO_MATCH
  rs485_modbus::IdentityInspector inspector;
  rs485_modbus::Transaction tx;
  CHECK(inspector.start(10, 20));
  bool held_tail = false;
  for (int i = 0; i < 300 && !inspector.done(); i++) {
    uint32_t before = esphome::test_millis;
    inspector.step(&bus, tx);
    CHECK_EQ_I64(esphome::test_millis, before);
    held_tail = held_tail || inspector.requires_bus_exclusive();
    esphome::delay(1);
  }
  CHECK(inspector.done());
  CHECK(held_tail);
  CHECK(!inspector.start(11, 20));  // an unread DONE result is still owned
  auto identity = inspector.take_result();
  CHECK(identity.kind == rs485_modbus::DeviceKind::FLOW);
  CHECK(!identity.conflicting);
}

static void test_periodic_identity_tail_catches_second_device() {
  printf("IdentityInspector: a delayed second reply cannot be flushed by another owner\n");
  esphome::test_millis = 0;
  UARTComponent bus;
  uint16_t low = 0, high = 0;
  float_to_regs_low_word_first(361.0f, low, high);
  auto frame = read_reply(10, {low, high});
  bus.timed_replies.push_back({{1, frame}, {12, frame}});
  rs485_modbus::IdentityInspector inspector;
  rs485_modbus::Transaction tx;
  CHECK(inspector.start(10, 30));
  for (int i = 0; i < 100 && !inspector.done(); i++) {
    inspector.step(&bus, tx);
    esphome::delay(1);
  }
  CHECK(inspector.done());
  auto identity = inspector.take_result();
  CHECK(identity.conflicting);
  CHECK_EQ_I64(bus.tx.size(), 8);  // pressure fingerprint was never started
}

// AddressInspector's PROBE_1 must report "bytes came back but no valid
// frame did", not fold it into NO_RESPONSE - read_holding_registers()
// computes that as `damaged`, and dropping it would let the whole
// address silently vanish from BOTH found and collisions. Without this,
// two physical devices on one address could show up as a collision on
// some scans and nothing at all on others: whichever of the two
// contended addresses happened to garble its very FIRST probe reply
// would lose all its evidence right there.
static void test_first_probe_damaged_is_not_dropped() {
  printf("AddressInspector: a damaged FIRST probe is not silently discarded\n");
  {
    // Two devices contending so hard that even the cheap 1-register probe
    // comes back mangled, every single time - PROBE_1 damaged, PROBE_1B
    // damaged again. Repeated activity on a request window is exactly the
    // correlation this project has always required before calling
    // anything a collision (see PROBE_1B's own comment) - it must not
    // vanish as "nothing answered". Shaped as a 7-byte reply (matching
    // what PROBE_1's own 1-register request expects) whose header names
    // neither our address nor our function - garbage, not a repairable
    // header.
    UARTComponent bus;
    auto damaged = with_crc({0x40, 0x02, 0x00, 0x00, 0x00});
    CHECK(damaged.size() == 7);
    bus.replies.push_back(damaged);
    bus.replies.push_back(damaged);
    auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
    CHECK(inspector.verdict() == rs485_modbus::AddressObservation::PROVEN_COLLISION);
  }
  {
    // A damaged probe that does NOT repeat is a passing glitch on an
    // otherwise quiet line, not two devices - PROBE_1B correlates it
    // against silence and the address is reported as empty, same as if
    // PROBE_1 itself had been silent.
    UARTComponent bus;
    auto damaged = with_crc({0x40, 0x02, 0x00, 0x00, 0x00});
    bus.replies.push_back(damaged);
    bus.replies.push_back({});
    auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
    CHECK(inspector.verdict() == rs485_modbus::AddressObservation::SILENCE);
  }
}

// AddressInspector must listen for a SECOND complete reply trailing a
// clean one before moving on, the same way the blocking helpers
// (second_reply_follows(), used by read_holding_registers()) always do -
// without that, PROBE_2's own start_request() (via flush_rx()) would
// silently discard whatever a second device's full, valid reply had
// already left sitting in the UART buffer, and two devices answering
// PROBE_1's exact request back to back, both perfectly formed frames,
// would read as one healthy device. TAIL_LISTEN (see the class's own
// comment) exists
// specifically to catch this, non-blockingly, the same way
// second_reply_follows() always did for the blocking callers.
static void test_two_full_frames_answer_the_same_request() {
  printf("AddressInspector: two complete replies to the SAME request prove a collision (tail listen)\n");
  UARTComponent bus;
  auto one_frame = read_reply(10, {0x000A});  // PROBE_1's own 1-register read, CRC-valid
  CHECK(one_frame.size() == 7);
  // Both devices answer PROBE_1 with a complete, valid frame, one right
  // after the other - concatenated into a single delivery, exactly what
  // a real UART buffer holds when the second reply arrives while nobody
  // has read the first one out yet.
  std::vector<uint8_t> two_frames = one_frame;
  two_frames.insert(two_frames.end(), one_frame.begin(), one_frame.end());
  bus.replies.push_back(two_frames);
  auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
  CHECK(inspector.verdict() == rs485_modbus::AddressObservation::PROVEN_COLLISION);
  // Caught during PROBE_1's own tail-listen window - PROBE_2 and
  // everything past it must never even be asked. Exactly one 8-byte
  // request on the wire proves that.
  CHECK_EQ_I64(bus.tx.size(), 8);
}

// Same bug, different ordering: the trailing second frame is HEADER-
// damaged rather than a second clean copy - two devices racing rarely
// line up byte-for-byte, so tail listen has to catch a mangled trailer
// too, not only a suspiciously perfect one. Anything at all arriving
// (at least SECOND_REPLY_MIN_BYTES of it) right after a reply that just
// validated is already proof enough - TAIL_LISTEN never has to parse it
// as a frame.
static void test_tail_listen_catches_a_damaged_trailing_reply() {
  printf("AddressInspector: a damaged trailer right after a clean reply still proves a collision\n");
  UARTComponent bus;
  auto one_frame = read_reply(10, {0x000A});
  std::vector<uint8_t> reply = one_frame;
  reply.insert(reply.end(), {0x40, 0x02, 0x00, 0x00});  // garbage tail, well over the 4-byte threshold
  bus.replies.push_back(reply);
  auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
  CHECK(inspector.verdict() == rs485_modbus::AddressObservation::PROVEN_COLLISION);
}

// PROBE_2 exists specifically for two devices whose alignment differs
// BETWEEN rounds: PROBE_1 happens to land as a clean single frame (pure
// chance), and only the SECOND, independent round catches the clash -
// the original two-T3-1-2-H-meters-on-one-address bug this project's
// very first collision fix was written for. Without PROBE_2, a device
// that merely got lucky once would sail straight through to the
// fingerprints and beyond as if it were alone.
static void test_probe_2_catches_a_second_round_collision() {
  printf("AddressInspector: PROBE_2 catches what PROBE_1's own lucky alignment missed\n");
  UARTComponent bus;
  bus.replies.push_back(read_reply(10, {0x000A}));               // PROBE_1: clean, by chance
  auto damaged_second_round = with_crc({0x40, 0x02, 0x00, 0x00, 0x00});
  bus.replies.push_back(damaged_second_round);                    // PROBE_2: the SAME address, different luck
  auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
  CHECK(inspector.verdict() == rs485_modbus::AddressObservation::PROVEN_COLLISION);
}

// PROBE_1B must not treat ANY non-silent reply - including a perfectly
// clean one - as proof of a collision, on the theory that "activity
// repeating" is itself the evidence: a single flaky device that answers
// PROBE_1 with a damaged frame (a transient line glitch) and then
// answers PROBE_1B cleanly on retry looks EXACTLY like that too - a lone
// device recovering, not two devices colliding. Only DAMAGED_ACTIVITY/
// PROVEN_COLLISION repeating on the retry is genuine correlation; a
// clean reply just proves a device is there and continues the normal
// sequence instead of a certain verdict.
static void test_probe_1b_clean_retry_is_not_a_certain_collision() {
  printf("AddressInspector: a damaged FIRST probe followed by a CLEAN retry is not called a certain collision\n");
  UARTComponent bus;
  auto damaged = with_crc({0x40, 0x02, 0x00, 0x00, 0x00});
  bus.replies.push_back(damaged);                                             // PROBE_1: damaged (one-off glitch)
  for (int i = 0; i < 2; i++) bus.replies.push_back(read_reply(10, {0x000A}));  // PROBE_1B, PROBE_2: clean
  bus.replies.push_back({});                                                  // FP_FLOW: no self-test register
  bus.replies.push_back(read_reply(10, {0x000A, 0x0003, 0x0003, 0x0002}));     // FP_PRESSURE: QDW90A block
  for (int i = 0; i < rs485_modbus::ADDRESS_INSPECTOR_CONFIRM_READS; i++) {
    bus.replies.push_back(read_reply(10, {0x0000, 0x0000}));  // CONFIRM x N: clean
  }
  auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
  CHECK(inspector.verdict() == rs485_modbus::AddressObservation::VALID_RESPONSE);
  CHECK(inspector.kind() == rs485_modbus::DeviceKind::PRESSURE);
}

// An address that answers PROBE_1 - proving something is
// there - and then falls completely silent for every request after it
// must never be reported as a confirmed single device. PROBE_2's own
// retry budget (ADDRESS_INSPECTOR_SILENCE_RETRIES) is spent and given up
// on well before CONFIRM is ever reached, so this also demonstrates that
// CONFIRM's own SILENCE fix (tested separately below) is not the only
// thing standing between this scenario and a false VALID_RESPONSE.
static void test_single_valid_probe_then_silence_is_not_confirmed() {
  printf("AddressInspector: one valid probe followed by silence everywhere is never called a confirmed device\n");
  UARTComponent bus;
  bus.replies.push_back(read_reply(10, {0x000A}));  // PROBE_1: valid - something is there
  // Nothing further is ever queued: PROBE_2's own retry (one extra
  // attempt) also finds nothing, and the inspector must give up rather
  // than march on to FP_FLOW/FP_PRESSURE/CONFIRM on the strength of a
  // single reply from several requests ago.
  auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
  CHECK(inspector.verdict() != rs485_modbus::AddressObservation::VALID_RESPONSE);
  CHECK(inspector.verdict() != rs485_modbus::AddressObservation::SILENCE);       // something WAS there once
  CHECK(inspector.verdict() == rs485_modbus::AddressObservation::DAMAGED_ACTIVITY);  // ambiguous, not proven either way
  // Exactly PROBE_1, then PROBE_2's own initial attempt and its one retry
  // (3 requests, 24 bytes) - must not have marched on to FP_FLOW/
  // FP_PRESSURE/CONFIRM at all.
  CHECK_EQ_I64(bus.tx.size(), 24);
}

// The narrowest reproduction of the CONFIRM counting bug itself: every
// phase up to and including the fingerprint that establishes the device
// kind succeeds cleanly, and only the live measurement block (CONFIRM)
// goes silent - a device that answered PROBE_1/PROBE_2/its own identity
// fingerprint but has nothing to say about the exact register block that
// fingerprint just proved it should support. Before this fix, every one
// of these silent reads still advanced confirm_done_, so this exact
// address would have reached "N reads all clean" and been reported
// VALID_RESPONSE off the strength of ONE real reply, from a completely
// different register, several requests earlier.
static void test_confirm_silence_does_not_count_as_a_clean_read() {
  printf("AddressInspector: CONFIRM's own retry budget does not let SILENCE pass as a clean read\n");
  UARTComponent bus;
  bus.replies.push_back(read_reply(10, {0x000A}));                          // PROBE_1
  bus.replies.push_back(read_reply(10, {0x000A}));                          // PROBE_2
  bus.replies.push_back({});                                               // FP_FLOW: no self-test register
  bus.replies.push_back(read_reply(10, {0x000A, 0x0003, 0x0003, 0x0002}));  // FP_PRESSURE: kind established
  // CONFIRM's own retry budget (one retry) is spent and exhausted on the
  // very first read - nothing past that is ever queued.
  auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
  CHECK(inspector.verdict() == rs485_modbus::AddressObservation::DAMAGED_ACTIVITY);
  // PROBE_1, PROBE_2, FP_FLOW, FP_PRESSURE, and CONFIRM's own two
  // attempts - 6 requests, 8 bytes each.
  CHECK_EQ_I64(bus.tx.size(), 48);
}

// FP_FLOW and FP_PRESSURE each carry their OWN damaged-reply detection
// (classify_flow_fingerprint_()/classify_pressure_fingerprint_() in
// rs485_modbus.h) - a garbled reply to EITHER fingerprint, on an address
// that has just answered two clean probes, is exactly the "device
// answers a register only the OTHER one implements while the first is
// still sending" pattern identify() was built to catch (see that
// function's own comment). Tested separately from PROBE_1/PROBE_1B/
// PROBE_2's own damaged handling above - a mutation removing only ONE
// fingerprint's damaged check must not slip through because the OTHER
// one happens to cover for it.
static void test_fingerprint_damage_proves_collision() {
  printf("AddressInspector: a damaged FLOW or PRESSURE fingerprint alone proves a collision\n");
  auto damaged = with_crc({0x40, 0x02, 0x00, 0x00, 0x00});
  {
    // Clean probes, then FP_FLOW comes back garbled.
    UARTComponent bus;
    bus.replies.push_back(read_reply(10, {0x000A}));
    bus.replies.push_back(read_reply(10, {0x000A}));
    bus.replies.push_back(damaged);  // FP_FLOW
    auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
    CHECK(inspector.verdict() == rs485_modbus::AddressObservation::PROVEN_COLLISION);
  }
  {
    // Clean probes, a clean (non-matching) flow fingerprint, then
    // FP_PRESSURE comes back garbled.
    UARTComponent bus;
    bus.replies.push_back(read_reply(10, {0x000A}));
    bus.replies.push_back(read_reply(10, {0x000A}));
    bus.replies.push_back({});       // FP_FLOW: no self-test register
    bus.replies.push_back(damaged);  // FP_PRESSURE
    auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
    CHECK(inspector.verdict() == rs485_modbus::AddressObservation::PROVEN_COLLISION);
  }
}

// The header-shaped CRC failure and the CRC-repaired-header collision are
// two different physical signatures of the same fault (two replies
// overlapping by different amounts - see Transaction::validate_()), and a
// real sweep can catch either shape on either contended address in either
// order. Both have to resolve to PROVEN_COLLISION, and swapping which
// address gets which shape (or which comes first) must not change the
// outcome.
static void test_header_damaged_and_crc_damaged_both_prove_collision() {
  printf("AddressInspector: a header-shaped CRC failure and a CRC-repairable one both prove a collision\n");
  auto header_shaped = with_crc({10, 0x03, 0x02, 0x00, 0x00});
  header_shaped[header_shaped.size() - 1] ^= 0xFF;  // our own header, CRC damaged
  // Header eaten, CRC intact once repaired (see validate_()) - built for a
  // 1-register reply, matching what PROBE_1 (the first thing
  // inspect_address_blocking() tries) actually requests.
  auto crc_repairable = read_reply(100, {0x0000});
  crc_repairable[0] = 0x40;
  crc_repairable[1] = 0x02;
  crc_repairable[2] = 0x00;
  {
    UARTComponent bus;
    bus.replies.push_back(header_shaped);
    auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 50);
    CHECK(inspector.verdict() == rs485_modbus::AddressObservation::PROVEN_COLLISION);
  }
  {
    UARTComponent bus;
    bus.replies.push_back(crc_repairable);
    auto inspector = rs485_modbus::inspect_address_blocking(&bus, 100, 50);
    CHECK(inspector.verdict() == rs485_modbus::AddressObservation::PROVEN_COLLISION);
  }
}

// Which instrument is at an address, read-only. The registers used are
// the ones this project has actually confirmed on its own hardware - the
// T3's 0361 self-test constant and the QDW90A's H:0-H:3 configuration
// block - NOT the T3's manufacturer-ID/ESN registers, which were found
// unreadable on this unit.
static void test_device_identification() {
  printf("device identification\n");
  auto flow_selftest = [] {
    uint32_t bits;
    float value = 361.0f;
    std::memcpy(&bits, &value, sizeof(bits));
    // low word first, matching decode_float_low_word_first()
    return with_crc({10, 0x03, 0x04, (uint8_t) ((bits >> 8) & 0xFF), (uint8_t) (bits & 0xFF),
                     (uint8_t) ((bits >> 24) & 0xFF), (uint8_t) ((bits >> 16) & 0xFF)});
  };
  {
    UARTComponent bus;
    bus.replies.push_back(flow_selftest());
    checks++;
    auto kind = rs485_modbus::identify_device(&bus, 10, 50);
    if (kind != rs485_modbus::DeviceKind::FLOW) {
      failures++;
      printf("  FAIL the T3 self-test register identifies a Flow meter, got %d\n", (int) kind);
    }
  }
  {
    // A QDW90A: no answer to the flow self-test, then its own H:0-H:3
    // block - address, baud code 3, unit code 3 (bar), 2 decimals.
    UARTComponent bus;
    bus.replies.push_back({});
    bus.replies.push_back(read_reply(10, {0x000A, 0x0003, 0x0003, 0x0002}));
    checks++;
    auto kind = rs485_modbus::identify_device(&bus, 10, 50);
    if (kind != rs485_modbus::DeviceKind::PRESSURE) {
      failures++;
      printf("  FAIL the QDW90A identity block identifies a Pressure sensor, got %d\n", (int) kind);
    }
  }
  {
    // A pressure block whose address register names someone else is not
    // this device - the fingerprint has to be tied to the address asked,
    // or it would confirm any answer at all.
    UARTComponent bus;
    bus.replies.push_back({});
    bus.replies.push_back(read_reply(10, {0x0037, 0x0003, 0x0003, 0x0002}));
    checks++;
    auto kind = rs485_modbus::identify_device(&bus, 10, 50);
    if (kind != rs485_modbus::DeviceKind::UNKNOWN) {
      failures++;
      printf("  FAIL a foreign address in the identity block is not a match, got %d\n", (int) kind);
    }
  }
  {
    // Something answers, but with neither fingerprint. "I don't know" is
    // the answer, and it must not be turned into a guess.
    UARTComponent bus;
    bus.replies.push_back({});
    bus.replies.push_back(read_reply(10, {0x000A, 0x0003, 0x0009, 0x0002}));  // unit code 9, not bar
    checks++;
    auto kind = rs485_modbus::identify_device(&bus, 10, 50);
    if (kind != rs485_modbus::DeviceKind::UNKNOWN) {
      failures++;
      printf("  FAIL an unrecognised device is UNKNOWN, not a guess, got %d\n", (int) kind);
    }
  }
}

// The one collision no frame can show. Two devices sharing an address
// whose replies are byte-identical superimpose into a perfectly valid
// frame - no CRC damage to notice, no late bytes left over - even for two
// different makes and models, if the registers being read happen to hold
// the same value on both. What separates them is asking a question they
// answer differently, which is what the two fingerprints are.
static void test_two_different_devices_on_one_address() {
  printf("identify: two different devices on one address\n");
  auto flow_selftest = [] {
    uint32_t bits;
    float value = 361.0f;
    std::memcpy(&bits, &value, sizeof(bits));
    return with_crc({10, 0x03, 0x04, (uint8_t) ((bits >> 8) & 0xFF), (uint8_t) (bits & 0xFF),
                     (uint8_t) ((bits >> 24) & 0xFF), (uint8_t) ((bits >> 16) & 0xFF)});
  };
  {
    UARTComponent bus;
    bus.replies.push_back(flow_selftest());                                  // the T3 answers
    bus.replies.push_back(read_reply(10, {0x000A, 0x0003, 0x0003, 0x0002}));  // ...and so does the QDW90A
    auto identity = rs485_modbus::identify(&bus, 10, 50);
    CHECK(identity.conflicting);
    // Neither answer can be trusted as "the" device here.
    CHECK(identity.kind == rs485_modbus::DeviceKind::UNKNOWN);
  }
  {
    // AddressInspector (Add/address-change/scan's shared evidence
    // machine) reports it as a collision rather than as a device - both
    // probes see one flawless reply, so the fingerprints are the only
    // thing that can catch it.
    UARTComponent bus;
    bus.replies.push_back(read_reply(10, {0x000A}));
    bus.replies.push_back(read_reply(10, {0x000A}));
    bus.replies.push_back(flow_selftest());
    bus.replies.push_back(read_reply(10, {0x000A, 0x0003, 0x0003, 0x0002}));
    auto inspector = rs485_modbus::inspect_address_blocking(&bus, 10, 20);
    CHECK(inspector.verdict() == rs485_modbus::AddressObservation::PROVEN_COLLISION);
  }
  {
    // One device still identifies cleanly - running both fingerprints
    // must not turn every device into a conflict.
    UARTComponent bus;
    bus.replies.push_back(flow_selftest());
    bus.replies.push_back({});  // nothing answers the pressure fingerprint
    auto identity = rs485_modbus::identify(&bus, 10, 50);
    CHECK(!identity.conflicting);
    CHECK(identity.kind == rs485_modbus::DeviceKind::FLOW);
  }
  {
    // What a contended fingerprint read really looks like, and the case
    // that matters most: the flow self-test is a register only the T3
    // implements, so the QDW90A refuses it in five bytes while the T3 is
    // still sending its longer data frame. Both land in the buffer.
    //
    // If the short refusal is accepted and the rest discarded, BOTH
    // fingerprints come back empty-handed and the address reads as a
    // harmless unidentified device - which is the one interpretation
    // that is certainly wrong, since they failed BECAUSE two devices
    // are there.
    UARTComponent bus;
    auto refusal = with_crc({10, 0x83, 0x02});  // QDW90A: no such register
    auto data = flow_selftest();                // T3: still talking
    refusal.insert(refusal.end(), data.begin(), data.end());
    bus.replies.push_back(refusal);
    bus.replies.push_back({});  // and the pressure fingerprint gets nowhere
    auto identity = rs485_modbus::identify(&bus, 10, 50);
    CHECK(identity.conflicting);
    CHECK(identity.kind == rs485_modbus::DeviceKind::UNKNOWN);
  }
  {
    // The same on the pressure fingerprint: a valid identity block with
    // the T3's own answer to the same request piled on behind it.
    UARTComponent bus;
    bus.replies.push_back({});  // nothing recognisable on the flow side
    auto identity_block = read_reply(10, {0x000A, 0x0003, 0x0003, 0x0002});
    auto other = read_reply(10, {0x1234, 0x5678, 0x9ABC, 0xDEF0});
    identity_block.insert(identity_block.end(), other.begin(), other.end());
    bus.replies.push_back(identity_block);
    auto identity = rs485_modbus::identify(&bus, 10, 50);
    CHECK(identity.conflicting);
  }
}

// Who is allowed to say an address is NOT contended. The measurement poll
// is not: a T3 and a QDW90A on one address answer its pressure block read
// with the same all-zero payload, so it sees one healthy sensor. It used
// to clear the Collision flag two seconds after any good reading, which
// wiped out what the scan had just found - the badge went red and back to
// OK, reading as "it was nothing".
static void test_collision_flag_ownership() {
  printf("collision flag: only a collision-aware check clears it\n");
  esphome::text_sensor::TextSensor collisions;
  esphome::text_sensor::TextSensor mismatches;
  esphome::binary_sensor::BinarySensor online;
  // What a bus scan found.
  rs485_modbus::set_scan_collision_address(&collisions, 10, true);
  CHECK_EQ_STR(collisions.state, "10");
  // A flawless measurement poll, over and over. It cannot see this fault,
  // so it must not be able to undo the verdict of something that can.
  for (int i = 0; i < 5; i++) {
    esphome::test_millis += 1000;
    rs485_modbus::publish_poll_result(&online, &collisions, &mismatches, 10, /*ok=*/true, /*collision=*/false,
                                      /*reachable=*/true, /*device_responded=*/true, /*identity_mismatch=*/false);
  }
  CHECK_EQ_STR(collisions.state, "10");
  CHECK(online.state);
  // ...and the identity check, which can, takes it back down.
  rs485_modbus::set_scan_collision_address(&collisions, 10, false);
  CHECK_EQ_STR(collisions.state, "");
}

// The same ownership question for the Mismatch flag. The identity check
// can find a flow meter on a Pressure slot whose registers happen to
// decode as a perfectly healthy 0.00 bar. Every poll in between decodes
// fine, and a poll that recomputes the flag from its own bytes alone
// would clear what the check just raised - the badge lighting for one
// poll every ten seconds and looking like a glitch.
static void test_mismatch_flag_ownership() {
  printf("mismatch flag: the identity check's verdict survives the polls between checks\n");
  esphome::text_sensor::TextSensor collisions;
  esphome::text_sensor::TextSensor mismatches;
  esphome::binary_sensor::BinarySensor online;
  // The identity check's verdict, carried the way the slot carries it -
  // as a remembered input to every poll's publish.
  bool identity_mismatch = true;
  rs485_modbus::set_scan_mismatch_address(&mismatches, 10, true);
  for (int i = 0; i < 30; i++) {
    esphome::test_millis += 333;
    rs485_modbus::publish_poll_result(&online, &collisions, &mismatches, 10, /*ok=*/true, /*collision=*/false,
                                      /*reachable=*/true, /*device_responded=*/true, identity_mismatch);
  }
  CHECK_EQ_STR(mismatches.state, "10");
  // The next check finds the right instrument (someone corrected the
  // Device Type): its verdict changes, and only then does the flag drop.
  identity_mismatch = false;
  rs485_modbus::publish_poll_result(&online, &collisions, &mismatches, 10, true, false, true, true,
                                    identity_mismatch);
  CHECK_EQ_STR(mismatches.state, "");
  // The poll's own witness still works on its own: a device that answers
  // but whose registers do not decode as the configured type is a
  // mismatch without any identity check saying so...
  rs485_modbus::publish_poll_result(&online, &collisions, &mismatches, 10, /*ok=*/false, false, true,
                                    /*device_responded=*/true, false);
  CHECK_EQ_STR(mismatches.state, "10");
  // ...a device that simply does not answer is not (that is Lost)...
  rs485_modbus::publish_poll_result(&online, &collisions, &mismatches, 10, false, false, true,
                                    /*device_responded=*/false, false);
  CHECK_EQ_STR(mismatches.state, "");
  // ...and a contended address is a Collision, never a Mismatch, whatever
  // either witness saw through it.
  rs485_modbus::publish_poll_result(&online, &collisions, &mismatches, 10, false, /*collision=*/true, true, true,
                                    /*identity_mismatch=*/true);
  CHECK_EQ_STR(mismatches.state, "");
  CHECK_EQ_STR(collisions.state, "10");
}

// The evidence a Collision verdict answers to between identity checks -
// see SlotLinkState's own comment for both rules.
static void test_link_state_rules() {
  printf("SlotLinkState: silence refutes a collision, one clean fingerprint does not\n");
  using rs485_modbus::TxResult;
  {
    // An unplugged device: the address goes silent. Two silent polls are
    // not yet an empty address (the blocking scan makes a healthy slot
    // miss a turn or two); the third is.
    rs485_modbus::SlotLinkState link;
    CHECK(!rs485_modbus::note_poll(link, TxResult::TIMEOUT, 1000));
    CHECK(!rs485_modbus::note_poll(link, TxResult::TIMEOUT, 1300));
    CHECK(rs485_modbus::note_poll(link, TxResult::TIMEOUT, 1600));
    // ...and only once, not on every poll thereafter.
    CHECK(!rs485_modbus::note_poll(link, TxResult::TIMEOUT, 1900));
  }
  {
    // Garbage is not silence: two devices clashing so badly that no frame
    // survives still put bytes on the wire, and that keeps the verdict.
    rs485_modbus::SlotLinkState link;
    CHECK(!rs485_modbus::note_poll(link, TxResult::TIMEOUT, 1000));
    CHECK(!rs485_modbus::note_poll(link, TxResult::TIMEOUT, 1300));
    CHECK(!rs485_modbus::note_poll(link, TxResult::BAD_FRAME, 1600));
    CHECK(!rs485_modbus::note_poll(link, TxResult::TIMEOUT, 1900));
    CHECK(!rs485_modbus::note_poll(link, TxResult::TIMEOUT, 2200));
    CHECK(rs485_modbus::note_poll(link, TxResult::TIMEOUT, 2500));
  }
  {
    // Two identical QDW90As on one address: the fingerprints come back
    // clean every time, the polls in between catch the replies colliding.
    rs485_modbus::SlotLinkState link;
    const uint32_t period = 10000;
    rs485_modbus::note_poll(link, TxResult::COLLISION, 5000);
    // First clean check: not on one sample.
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, true, 10000, period));
    // Second clean check, but a damaged reply within the last period.
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, true, 14000, period));
    // Still colliding: a poll catches another one.
    rs485_modbus::note_poll(link, TxResult::COLLISION, 15000);
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, true, 20000, period));
    // The other device is unplugged: a full quiet period, then a clean
    // check - and the earlier clean checks still count.
    CHECK(rs485_modbus::identity_may_clear_collision(link, false, true, 25001, period));
  }
  {
    // A pressure sensor and a flow meter on one address: the fingerprint
    // reads collide most of the time, and the odd clean sample in
    // between must not reset the verdict.
    rs485_modbus::SlotLinkState link;
    CHECK(!rs485_modbus::identity_may_clear_collision(link, true, true, 10000, 10000));
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, true, 20000, 10000));
    CHECK(!rs485_modbus::identity_may_clear_collision(link, true, true, 30000, 10000));
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, true, 40000, 10000));
    // Actually fixed: two clean checks in a row.
    CHECK(rs485_modbus::identity_may_clear_collision(link, false, true, 50000, 10000));
  }
  {
    // A healthy slot that was never flagged: the check is trusted on its
    // second clean sample even though it has nothing to clear.
    rs485_modbus::SlotLinkState link;
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, true, 10000, 10000));
    CHECK(rs485_modbus::identity_may_clear_collision(link, false, true, 20000, 10000));
  }
  {
    // A check that reached no verdict (neither fingerprint answered) is
    // not a clean sample: it neither counts toward clearing nor resets
    // what has been counted.
    rs485_modbus::SlotLinkState link;
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, /*known=*/false, 10000, 10000));
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, /*known=*/false, 20000, 10000));
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, true, 30000, 10000));
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, /*known=*/false, 40000, 10000));
    CHECK(rs485_modbus::identity_may_clear_collision(link, false, true, 50000, 10000));
  }
  {
    // note_poll() must reset clean_identity_checks on a fresh COLLISION,
    // not just set collision_seen/last_collision_ms - otherwise two clean
    // checks recorded LONG BEFORE an unrelated collision started could
    // satisfy "clean twice in a row" with only ONE genuinely
    // post-collision clean sample, one real check away from the exact
    // flicker this whole counter exists to prevent.
    rs485_modbus::SlotLinkState link;
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, true, 1000, 10000));  // 1st clean
    CHECK(rs485_modbus::identity_may_clear_collision(link, false, true, 2000, 10000));   // 2nd - threshold reached
    // A collision now starts, unrelated to those two stale clean checks.
    rs485_modbus::note_poll(link, TxResult::COLLISION, 5000);
    // Without the fix, clean_identity_checks would already be at 2 (from
    // before the collision) and this single post-collision clean check
    // would push it to 3 - still >= the threshold, and by ms=20000 the
    // time-gate (20000-5000=15000 >= period 10000) has already opened,
    // so the OLD code returns true right here. The fix must not.
    CHECK(!rs485_modbus::identity_may_clear_collision(link, false, true, 20000, 10000));
    // A second clean check after the collision, safely past the period,
    // is what actually earns clearing it.
    CHECK(rs485_modbus::identity_may_clear_collision(link, false, true, 30001, 10000));
  }
  {
    // The per-slot instances: the same slot gets the same state back on
    // every call, even through a different copy of its key, and two
    // slots never share one. (Not an ESPHome global - see slot_link().)
    std::string key1 = "slot1", key1_again = "slot1", key2 = "slot2";
    auto &a = rs485_modbus::slot_link(key1.c_str());
    a.silent_polls = 7;
    CHECK(rs485_modbus::slot_link(key1_again.c_str()).silent_polls == 7);
    CHECK(rs485_modbus::slot_link(key2.c_str()).silent_polls == 0);
    rs485_modbus::slot_link(key1.c_str()) = rs485_modbus::SlotLinkState{};
    CHECK(rs485_modbus::slot_link(key1.c_str()).silent_polls == 0);
  }
}

// A scan that says "there is a device at 10" and stops there leaves the
// person to work out which instrument it is - and a wrong guess is not
// cosmetic, since the slot would then poll a register block that means
// something else entirely on that device. The sweep therefore carries the
// type alongside the address.
//
// --- the non-blocking scan --------------------------------------------
// Drives rs485_modbus::scan_controller() the same way the central
// scheduler does: one step() per (simulated) tick, never a spin loop
// inside the scan itself - only this harness's own outer wait, exactly
// like every other blocking helper's tests already do.
static rs485_modbus::ScanResult run_scan(UARTComponent &bus, uint8_t min_address, uint8_t max_address,
                                          uint32_t per_address_timeout_ms) {
  auto &scan = rs485_modbus::scan_controller();
  CHECK(scan.start(min_address, max_address, per_address_timeout_ms));
  rs485_modbus::Transaction tx;
  int guard = 0;
  while (!scan.step(&bus, tx)) {
    esphome::App.feed_wdt();
    esphome::yield();
    checks++;
    if (++guard > 200000) {
      failures++;
      printf("  FAIL scan never completed (runaway loop) for %d-%d\n", min_address, max_address);
      break;
    }
  }
  return scan.take_result();
}

static void test_scan_reports_device_types() {
  printf("scan: found devices carry their type\n");
  UARTComponent bus;
  // Address 10 answers the two probes, has no flow self-test, and then
  // produces a QDW90A identity block.
  bus.replies.push_back(read_reply(10, {0x000A}));
  bus.replies.push_back(read_reply(10, {0x000A}));
  bus.replies.push_back({});
  bus.replies.push_back(read_reply(10, {0x000A, 0x0003, 0x0003, 0x0002}));
  for (int i = 0; i < rs485_modbus::ADDRESS_INSPECTOR_CONFIRM_READS; i++) {
    bus.replies.push_back(read_reply(10, {0x000A, 0x0000}));  // pressure block, clean every time
  }
  auto result = run_scan(bus, 10, 10, 20);
  CHECK(result.found.size() == 1 && result.found[0] == 10);
  checks++;
  if (result.kinds.size() != 1 || result.kinds[0] != rs485_modbus::DeviceKind::PRESSURE) {
    failures++;
    printf("  FAIL the scan reports what the device is, got %d kind(s)\n", (int) result.kinds.size());
  }
  {
    // An address whose type the fingerprints do not recognise is still
    // found - it just has no type to offer, which the dashboard shows as
    // an unanswered dropdown rather than a guess.
    UARTComponent quiet;
    quiet.replies.push_back(read_reply(11, {0x000B}));
    quiet.replies.push_back(read_reply(11, {0x000B}));
    quiet.replies.push_back({});
    quiet.replies.push_back({});
    for (int i = 0; i < rs485_modbus::ADDRESS_INSPECTOR_CONFIRM_READS; i++) quiet.replies.push_back(read_reply(11, {0x000B}));
    auto unknown = run_scan(quiet, 11, 11, 20);
    CHECK(unknown.found.size() == 1);
    checks++;
    if (unknown.kinds.size() != 1 || unknown.kinds[0] != rs485_modbus::DeviceKind::UNKNOWN) {
      failures++;
      printf("  FAIL an unidentified device is reported as UNKNOWN\n");
    }
  }
}

// Two genuinely contended addresses in ONE sweep, each proven a
// different way, with 89 silent addresses in between (matching a real
// 1-247 sweep's shape - the overwhelming majority of addresses answer
// nothing at all). Both must come back as collisions and NEITHER as
// found - a probe with a blind spot for a damaged first reply could
// otherwise make one address vanish from the result entirely depending
// on unrelated bit-alignment luck.
static void test_scan_finds_every_collision_in_range() {
  printf("scan: two contended addresses in one sweep are both reported, neither as found\n");
  UARTComponent bus;
  // Queued per TARGET ADDRESS (see replies_by_address's own comment in
  // the UART stub) - required the moment the sweep is wide enough to
  // have genuinely silent addresses in between two answering ones, which
  // a real 1-247 sweep always does. A flat, address-agnostic queue would
  // hand address 100's own reply to address 11 the moment address 11
  // wrote first, since nothing was ever queued FOR address 11 to
  // legitimately consume instead.
  auto &at10 = bus.replies_by_address[10];
  auto &at100 = bus.replies_by_address[100];
  // Address 10: repeated damaged probes (PROBE_1B correlation). Shaped
  // as a 7-byte reply matching PROBE_1's own 1-register request, header
  // naming neither our address nor our function.
  auto damaged10 = with_crc({0x40, 0x02, 0x00, 0x00, 0x00});
  at10.push_back(damaged10);
  at10.push_back(damaged10);
  // Address 100: two identical QDW90As, caught on the 4th confirmation
  // read.
  at100.push_back(read_reply(100, {0x0064}));
  at100.push_back(read_reply(100, {0x0064}));
  at100.push_back({});
  at100.push_back(read_reply(100, {0x0064, 0x0003, 0x0003, 0x0002}));
  auto clean100 = read_reply(100, {0x0000, 0x0000});
  auto superposed100 = clean100;
  superposed100[0] = 0x40;
  superposed100[1] = 0x02;
  superposed100[2] = 0x00;
  at100.push_back(clean100);
  at100.push_back(clean100);
  at100.push_back(clean100);
  at100.push_back(superposed100);
  // Addresses 11-99 get no queued reply at all, on any address - genuine
  // silence, 89 of them, exactly the shape a real sweep has.
  auto result = run_scan(bus, 10, 100, 5);
  CHECK(result.found.empty());
  checks++;
  auto sorted = result.collisions;
  std::sort(sorted.begin(), sorted.end());
  if (sorted.size() != 2 || sorted[0] != 10 || sorted[1] != 100) {
    failures++;
    printf("  FAIL expected collisions exactly {10,100}, got %zu address(es)\n", sorted.size());
    for (uint8_t a : sorted) printf("        - %d\n", a);
  }
}

// Whether the proving evidence is the FIRST confirmation read or the
// LAST must not change the outcome - only "does at least one turn up"
// matters, never its position in the sequence.
static void test_scan_collision_position_does_not_matter() {
  printf("scan: a collision proven early or late in the confirmation reads gives the same verdict\n");
  auto clean = read_reply(100, {0x0000, 0x0000});
  auto superposed = clean;
  superposed[0] = 0x40;
  superposed[1] = 0x02;
  superposed[2] = 0x00;
  auto identify_prefix = [](UARTComponent &bus) {
    bus.replies.push_back(read_reply(100, {0x0064}));
    bus.replies.push_back(read_reply(100, {0x0064}));
    bus.replies.push_back({});
    bus.replies.push_back(read_reply(100, {0x0064, 0x0003, 0x0003, 0x0002}));
  };
  {
    // Damaged evidence LAST.
    UARTComponent bus;
    identify_prefix(bus);
    bus.replies.push_back(clean);
    bus.replies.push_back(clean);
    bus.replies.push_back(clean);
    bus.replies.push_back(superposed);
    auto result = run_scan(bus, 100, 100, 20);
    CHECK(result.found.empty());
    CHECK(result.collisions.size() == 1 && result.collisions[0] == 100);
  }
  {
    // Damaged evidence FIRST - same final verdict.
    UARTComponent bus;
    identify_prefix(bus);
    bus.replies.push_back(superposed);
    auto result = run_scan(bus, 100, 100, 20);
    CHECK(result.found.empty());
    CHECK(result.collisions.size() == 1 && result.collisions[0] == 100);
  }
}

// Progress has to be observable before the first Modbus byte goes out -
// otherwise "Scan In Progress" going true and false again inside one
// blocking call can coalesce into nothing arriving at all (the spinner
// bug). start() alone must arm the active/progress state with zero bus
// traffic; the first request only goes out on the NEXT step().
static void test_scan_progress_observable_before_first_transaction() {
  printf("scan: active() (and current_address()) are true before any request is sent\n");
  auto &scan = rs485_modbus::scan_controller();
  UARTComponent bus;
  CHECK(scan.start(10, 10, 20));
  CHECK(scan.active());
  CHECK(scan.current_address() == 10);
  checks++;
  if (!bus.tx.empty()) {
    failures++;
    printf("  FAIL start() should not itself put anything on the wire\n");
  }
  // Drain it so the singleton is clean for the next test.
  bus.replies.push_back({});
  rs485_modbus::Transaction tx;
  while (!scan.step(&bus, tx)) esphome::yield();
  CHECK(!scan.active());
}

// A second "Find Modbus Devices" press while one sweep is still running
// must not start (or queue) a second one.
static void test_scan_double_start_is_a_noop() {
  printf("scan: starting while already active is refused, not queued\n");
  auto &scan = rs485_modbus::scan_controller();
  UARTComponent bus;
  CHECK(scan.start(10, 10, 20));
  CHECK(!scan.start(50, 60, 20));  // refused - the in-flight sweep is untouched
  checks++;
  if (scan.min_address() != 10 || scan.max_address() != 10) {
    failures++;
    printf("  FAIL a refused second start must not alter the sweep already running\n");
  }
  bus.replies.push_back({});
  rs485_modbus::Transaction tx;
  while (!scan.step(&bus, tx)) esphome::yield();
  CHECK(!scan.active());
}

// --- collision registry reconciliation --------------------------------
// The scan's own snapshot and a registered slot's live SlotLinkState-
// driven collision flag used to be the same CSV, wholesale-overwritten
// by every scan - which meant a scan pass that (through its own,
// independent alignment luck) failed to re-catch a collision a
// REGISTERED slot's continuous polling had just proven would silently
// erase that proof. reconcile_scan_collisions() is the fix: a scan may
// only speak for addresses nothing has registered.
static void test_reconcile_scan_collisions_respects_registered_slots() {
  printf("reconcile_scan_collisions: a scan cannot overrule a registered slot's own live verdict\n");
  // Address 10 is a REGISTERED slot's own collision (proven by its live
  // polling, not by this scan) and address 50 is a stale, unregistered
  // scan finding from an earlier pass that this new sweep re-covers.
  std::string old_csv = "10,50";
  std::vector<uint8_t> registered = {10};  // slot1 sits on address 10
  {
    // This sweep covers 1-100, finds NOTHING contended (the unregistered
    // 50 has been fixed since) - 10 must survive because it belongs to a
    // registered slot's own live evidence; 50 must clear because nothing
    // but a scan could ever re-decide an unregistered address.
    auto result = rs485_modbus::reconcile_scan_collisions(old_csv, 1, 100, registered, {});
    CHECK_EQ_STR(result, "10");
  }
  {
    // The same sweep, but it also finds a NEW unregistered collision at
    // 77 - added, while 10 is still left alone.
    auto result = rs485_modbus::reconcile_scan_collisions(old_csv, 1, 100, registered, {77});
    CHECK_EQ_STR(result, "10,77");
  }
  {
    // A sweep that does not cover address 10 at all (e.g. a narrower
    // manual range) must not touch it either way, registered or not.
    auto result = rs485_modbus::reconcile_scan_collisions("50", 60, 100, {}, {});
    CHECK_EQ_STR(result, "50");
  }
}

// Skipping scan_collisions entirely for a registered address
// (`if (is_registered(a)) continue;` before it ever gets a chance to add
// anything) would discard a scan's own genuine finding of a SECOND
// device sharing an already-registered address at publish time - the one
// collision a scan exists to catch that the slot's own single-address
// live polling structurally cannot see on its own. Addition and removal
// are not the same operation for a registered address and must not
// share one guard.
static void test_reconcile_scan_collisions_asymmetric_add_vs_remove() {
  printf("reconcile_scan_collisions: adding a registered address's own new collision vs. never removing its old one\n");
  {
    // Nothing recorded yet, a registered slot sits on address 10, and
    // THIS sweep is the one that catches a second device sharing it -
    // must be added, not silently dropped because 10 is registered.
    auto result = rs485_modbus::reconcile_scan_collisions("", 1, 100, {10}, {10});
    CHECK_EQ_STR(result, "10");
  }
  {
    // 10 is already flagged (by the slot's own live polling, or an
    // earlier scan) and THIS sweep - one pass, its own alignment luck -
    // does not happen to re-detect it. Must survive: only the live
    // poll's own evidence may retract a registered address's collision,
    // never a single clean scan pass.
    auto result = rs485_modbus::reconcile_scan_collisions("10", 1, 100, {10}, {});
    CHECK_EQ_STR(result, "10");
  }
}

// --- realistic wire timing (UARTComponent::timed_replies) ------------------
// Every test above hands a state machine a complete reply the instant it
// asks - which exercises the EVIDENCE rules but never the state machine's
// own handling of a reply that actually takes wall-clock time to arrive.
// These use the mock's staged-delivery mode instead: bytes only become
// visible once their own scheduled delay has genuinely elapsed, so a
// Transaction polled once per (simulated) tick has to be polled more than
// once to see the reply complete, same as it would over a real 9600-baud
// line - and a "delayed second frame" is a second chunk scheduled to
// arrive after the first one has already completed, not bytes pre-loaded
// in the same instant.
static void test_transaction_handles_a_reply_trickling_in() {
  printf("Transaction: a reply that arrives in separate, timed chunks still completes correctly\n");
  UARTComponent bus;
  auto reply = read_reply(10, {0x000A});  // address, function, count, 2 data bytes, 2 CRC bytes = 7 bytes
  CHECK(reply.size() == 7);
  // Delivered as three separate chunks, 2ms apart - roughly a byte's
  // worth of time at 9600 baud - instead of all at once.
  bus.timed_replies.push_back({
      {2, {reply[0], reply[1], reply[2]}},
      {4, {reply[3], reply[4]}},
      {6, {reply[5], reply[6]}},
  });
  rs485_modbus::Transaction tx;
  CHECK(tx.start_read(&bus, 10, 0, 1, 50));
  int polls_before_done = 0;
  while (!tx.done()) {
    tx.poll(&bus);
    if (!tx.done()) {
      esphome::yield();  // advances esphome::test_millis by 1ms, same as a real tick
      polls_before_done++;
    }
    CHECK(polls_before_done < 100);  // guard against a runaway loop on failure
  }
  uint16_t regs[1];
  size_t received = 0;
  CHECK(tx.take(regs, 1, &received) == rs485_modbus::TxResult::OK);
  CHECK_EQ_I64(received, 1);
  CHECK_EQ_I64(regs[0], 0x000A);
  checks++;
  if (polls_before_done < 5) {
    // If this is ever too low, the mock stopped actually staging delivery
    // and started handing the whole reply over on the first poll again -
    // which is precisely the unrealistic shortcut this test exists to
    // rule out.
    failures++;
    printf("  FAIL the reply arrived too readily - staged delivery is not being exercised (%d polls)\n",
           polls_before_done);
  }
}

// A delayed SECOND frame - not bytes pre-loaded alongside the first, but
// a second device's reply scheduled to land well after the first frame
// has already completed and been read. This is what second_reply_follows()
// (include/rs485_modbus.h) exists to catch, tested here against a mock
// that genuinely delays the second frame rather than concatenating it
// onto the first up front.
static void test_second_reply_follows_a_genuinely_delayed_frame() {
  printf("second_reply_follows: a second device's reply arrives well after the first, on its own schedule\n");
  UARTComponent bus;
  auto first = read_reply(10, {0x000A});
  auto second = read_reply(10, {0x000A});
  bus.timed_replies.push_back({
      {0, first},          // the device we asked, essentially immediately
      {10, second},         // a second device's reply, 10ms later - well inside the 25ms window
  });
  uint16_t regs[1];
  bool collision = false;
  bool ok = rs485_modbus::read_holding_registers(&bus, 10, 0, 1, regs, 1, 50, &collision);
  CHECK(ok);
  CHECK(collision);
}

// --- decoding --------------------------------------------------------------

// The polling path is "read the block, then decode it" - two steps, in
// the slot's own _poll_finish. These test the same pair.
static void test_read_pressure_bar() {
  printf("pressure block read + decode\n");
  {
    UARTComponent bus;
    float sample = 3.25f;
    uint32_t bits;
    std::memcpy(&bits, &sample, sizeof(bits));
    // QDW90A is high word first (the opposite of the T3-1-2-H).
    bus.replies.push_back(read_reply(2, {static_cast<uint16_t>(bits >> 16), static_cast<uint16_t>(bits & 0xFFFF)}));
    uint16_t regs[2] = {0, 0};
    CHECK(rs485_modbus::read_holding_registers(&bus, 2, rs485_modbus::PRESSURE_BLOCK_START_REG,
                                               rs485_modbus::PRESSURE_BLOCK_REGISTERS, regs, 2, 50));
    float out = 0;
    CHECK(rs485_modbus::decode_pressure_bar(regs, out));
    CHECK(out == 3.25f);
  }
  {
    // A NaN payload is a decode of something that isn't a pressure -
    // refused rather than published as a reading.
    UARTComponent bus;
    bus.replies.push_back(read_reply(2, {0x7FC0, 0x0000}));
    uint16_t regs[2] = {0, 0};
    CHECK(rs485_modbus::read_holding_registers(&bus, 2, 22, 2, regs, 2, 50));
    float out = -1;
    CHECK(!rs485_modbus::decode_pressure_bar(regs, out));
    CHECK(out == -1);  // untouched
  }
  {
    // ...and so is an absurd magnitude.
    UARTComponent bus;
    float sample = 1e30f;
    uint32_t bits;
    std::memcpy(&bits, &sample, sizeof(bits));
    bus.replies.push_back(read_reply(2, {static_cast<uint16_t>(bits >> 16), static_cast<uint16_t>(bits & 0xFFFF)}));
    uint16_t regs[2] = {0, 0};
    CHECK(rs485_modbus::read_holding_registers(&bus, 2, 22, 2, regs, 2, 50));
    float out = -1;
    CHECK(!rs485_modbus::decode_pressure_bar(regs, out));
  }
}

static void test_decode_flow_total_ml() {
  printf("decode_flow_total_ml\n");
  int64_t ml = 0;
  uint32_t nf_bits;
  float nf;

  // 42 litres and 692 millilitres -> 42692 ml exactly. This is the
  // reading that motivated the whole integer rework: as a float of m3 it
  // is 0.042692, which a float32 can only approximate.
  nf = 0.692f;
  std::memcpy(&nf_bits, &nf, sizeof(nf_bits));
  CHECK(rs485_modbus::decode_flow_total_ml(42, nf_bits, ml));
  CHECK_EQ_I64(ml, 42692);

  // A large, realistic household total stays exact - 12345.123456 m3.
  nf = 0.456f;
  std::memcpy(&nf_bits, &nf, sizeof(nf_bits));
  CHECK(rs485_modbus::decode_flow_total_ml(12345123u, nf_bits, ml));
  CHECK_EQ_I64(ml, 12345123456LL);
  // The same value as a float of m3 is NOT this number - that difference
  // is exactly what the integer path exists to avoid.
  CHECK((int64_t) llround((double) (float) 12345.123456 * 1e6) != 12345123456LL);

  // The fractional register must be a fraction of one litre; anything
  // else means these registers aren't what we think they are.
  nf = 1.5f;
  std::memcpy(&nf_bits, &nf, sizeof(nf_bits));
  CHECK(!rs485_modbus::decode_flow_total_ml(42, nf_bits, ml));
  nf = -0.1f;
  std::memcpy(&nf_bits, &nf, sizeof(nf_bits));
  CHECK(!rs485_modbus::decode_flow_total_ml(42, nf_bits, ml));
  nf = NAN;
  std::memcpy(&nf_bits, &nf, sizeof(nf_bits));
  CHECK(!rs485_modbus::decode_flow_total_ml(42, nf_bits, ml));
}

static void test_read_flow_block() {
  printf("flow block read + decode\n");
  std::vector<uint16_t> regs(12, 0);
  float_to_regs_low_word_first(0.49f, regs[0], regs[1]);
  regs[8] = 42 & 0xFFFF;  // N low word
  regs[9] = 42 >> 16;     // N high word
  float_to_regs_low_word_first(0.692f, regs[10], regs[11]);
  {
    UARTComponent bus;
    bus.replies.push_back(read_reply(1, regs));
    uint16_t got[rs485_modbus::FLOW_BLOCK_REGISTERS] = {};
    bool collision = true;
    bool responded = false;
    CHECK(rs485_modbus::read_holding_registers(&bus, 1, rs485_modbus::FLOW_BLOCK_START_REG,
                                               rs485_modbus::FLOW_BLOCK_REGISTERS, got,
                                               rs485_modbus::FLOW_BLOCK_REGISTERS, 50, &collision, &responded));
    float instant = 0;
    int64_t total_ml = 0;
    CHECK(rs485_modbus::decode_flow_block(got, instant, total_ml));
    CHECK(instant == 0.49f);
    CHECK_EQ_I64(total_ml, 42692);
    CHECK(!collision);
    CHECK(responded);
    // ONE transaction for both values - the whole point of the block
    // read. Eight bytes out, nothing more.
    CHECK_EQ_I64(bus.tx.size(), 8);
    CHECK_EQ_I64(bus.tx[5], 12);  // 12 registers in a single request
  }
  {
    // An implausible instant rate fails the whole read - a frame that
    // decodes to nonsense in one field is not trustworthy in another.
    auto bad = regs;
    float_to_regs_low_word_first(NAN, bad[0], bad[1]);
    UARTComponent bus;
    bus.replies.push_back(read_reply(1, bad));
    uint16_t got[rs485_modbus::FLOW_BLOCK_REGISTERS] = {};
    CHECK(rs485_modbus::read_holding_registers(&bus, 1, 0, rs485_modbus::FLOW_BLOCK_REGISTERS, got,
                                               rs485_modbus::FLOW_BLOCK_REGISTERS, 50));
    float instant = 0;
    int64_t total_ml = -1;
    CHECK(!rs485_modbus::decode_flow_block(got, instant, total_ml));
    CHECK_EQ_I64(total_ml, -1);  // untouched
  }
  {
    // Reverse flow is real on this meter and must NOT be rejected.
    auto reverse = regs;
    float_to_regs_low_word_first(-0.25f, reverse[0], reverse[1]);
    UARTComponent bus;
    bus.replies.push_back(read_reply(1, reverse));
    uint16_t got[rs485_modbus::FLOW_BLOCK_REGISTERS] = {};
    CHECK(rs485_modbus::read_holding_registers(&bus, 1, 0, rs485_modbus::FLOW_BLOCK_REGISTERS, got,
                                               rs485_modbus::FLOW_BLOCK_REGISTERS, 50));
    float instant = 0;
    int64_t total_ml = 0;
    CHECK(rs485_modbus::decode_flow_block(got, instant, total_ml));
    CHECK(instant == -0.25f);
  }
}

// --- volumes ---------------------------------------------------------------

static void test_parse_m3_to_ml() {
  printf("volume::parse_m3_to_ml\n");
  int64_t ml = 0;

  struct Good {
    const char *text;
    int64_t ml;
  } good[] = {
      {"0", 0},
      {"12345", 12345000000LL},
      {"12345.001", 12345001000LL},
      {"12345,123456", 12345123456LL},   // decimal comma, Hungarian keyboard
      {"0.062691", 62691},
      {"0.062692", 62692},               // the 1 ml correction an earlier round destroyed
      {"  42.5  ", 42500000LL},          // surrounding whitespace is not junk
      {"-1.5", -1500000LL},
      {"+3", 3000000LL},
      {"100000", 100000000000LL},        // the top of the Reading field's range
      {"999999999999", 999999999999000000LL},  // twelve whole digits: the last width that fits int64 in ml
  };
  for (const auto &g : good) {
    ml = -12345;
    bool ok = volume::parse_m3_to_ml(g.text, ml);
    checks++;
    if (!ok || ml != g.ml) {
      failures++;
      printf("  FAIL parse(\"%s\") -> ok=%d ml=%lld, expected ml=%lld\n", g.text, (int) ok, (long long) ml,
             (long long) g.ml);
    }
  }

  // Everything parseFloat() used to accept by stopping early, plus the
  // "finer than a millilitre" case that must be refused rather than
  // rounded.
  const char *bad[] = {
      "",  " ", "abc", "12abc", "1,2,3", "12 345,678", "12.", ".5", "1e6", "12345.0000001", "--1", "0x10", "12.3.4",
      // Thirteen whole digits x 1e6 does not fit int64 - has to be refused
      // by the width guard, before the multiply, not caught by the range
      // check after it has already wrapped.
      "9999999999999",
  };
  for (const char *b : bad) {
    ml = -12345;
    checks++;
    if (volume::parse_m3_to_ml(b, ml)) {
      failures++;
      printf("  FAIL parse(\"%s\") should have been refused, got %lld\n", b, (long long) ml);
    }
  }
}

static void test_publish_volume() {
  printf("volume::publish_volume\n");
  esphome::sensor::Sensor total;
  esphome::sensor::Sensor offset;
  esphome::text_sensor::TextSensor exact;

  volume::publish_volume(&total, &offset, &exact, 12345123456LL, -876544LL);
  CHECK_EQ_STR(exact.state, "12345123456|-876544");
  // The float sensors are HA's view and are allowed to be approximate -
  // what matters is that they're the right value to within a float.
  CHECK(std::fabs(total.state - 12345.123456) < 0.01);
  CHECK(std::fabs(offset.state - (-0.876544)) < 1e-6);

  // Identical values a second time are not republished - at three polls
  // a second per device that is the difference between an update rate
  // that follows the measurements and one that follows the poll clock.
  size_t before = total.published.size();
  volume::publish_volume(&total, &offset, &exact, 12345123456LL, -876544LL);
  CHECK_EQ_I64(total.published.size(), before);

  // ...but a meter that went unavailable and came back MUST be
  // republished, even though its volume never moved. This is the bug
  // that stranded a flow meter as "--" indefinitely: one failed poll
  // published NAN, and every later successful poll saw an unchanged
  // exact string and skipped.
  total.publish_state(NAN);
  volume::publish_volume(&total, &offset, &exact, 12345123456LL, -876544LL);
  CHECK(!std::isnan(total.state));
  CHECK(std::fabs(total.state - 12345.123456) < 0.01);

  // The same for the correction sensor on its own.
  offset.publish_state(NAN);
  volume::publish_volume(&total, &offset, &exact, 12345123456LL, -876544LL);
  CHECK(!std::isnan(offset.state));

  // A meter with no Correction Offset sensor of its own (the pulse
  // meters) still gets its offset onto the exact channel.
  esphome::sensor::Sensor pulse_total;
  esphome::text_sensor::TextSensor pulse_exact;
  volume::publish_volume(&pulse_total, nullptr, &pulse_exact, 7000LL, 7000LL);
  CHECK_EQ_STR(pulse_exact.state, "7000|7000");
}

static void test_publish_update_result() {
  printf("volume::publish_update_result\n");
  esphome::text_sensor::TextSensor result;
  volume::publish_update_result(&result, "Pulse Meter 1", "ok", "12345.678");
  volume::publish_update_result(&result, "Pulse Meter 1", "ok", "12345.678");
  CHECK_EQ_I64(result.published.size(), 2);
  // Two identical outcomes must still be two distinguishable publishes -
  // otherwise the second Update in a row would look like it never
  // reported back at all.
  CHECK(result.published[0] != result.published[1]);
  CHECK(result.published[1].find("|Pulse Meter 1|ok|12345.678") != std::string::npos);

  // The request is echoed back so a client can tell its own outcome from
  // another tab's - and it is echoed VERBATIM, including a malformed one,
  // because a refusal is exactly the case a client most needs to match.
  volume::publish_update_result(&result, "Pulse Meter 1", "invalid", "12|abc");
  CHECK(result.published.back().find("|invalid|12|abc") != std::string::npos);
  // The reader takes everything after the third separator, so a '|' in
  // the request survives the round trip.
  std::string last = result.published.back();
  size_t first = last.find('|');
  size_t second = last.find('|', first + 1);
  size_t third = last.find('|', second + 1);
  CHECK_EQ_STR(last.substr(third + 1), "12|abc");
}

// --- the arithmetic each package actually performs --------------------------
// These mirror the offset/total maths in packages/water_meter.yaml and
// packages/pressure_sensor.yaml exactly. They are here because that is
// the arithmetic a wrong reading would come out of, and a lambda inside a
// YAML file cannot be unit-tested directly.

static void test_calibration_arithmetic() {
  printf("calibration arithmetic\n");
  const int64_t ML_PER_PULSE = 1000;  // liters_per_pulse: "1.0"

  // Pulse meter: set a meter that has counted 9 pulses to read 12345.001.
  int64_t target_ml = 0;
  CHECK(volume::parse_m3_to_ml("12345.001", target_ml));
  int64_t offset_ml = target_ml - 9 * ML_PER_PULSE;
  CHECK_EQ_I64(offset_ml, 12344992000LL);
  // ...and the total it then reports is exactly what was asked for.
  CHECK_EQ_I64(offset_ml + 9 * ML_PER_PULSE, target_ml);
  // One more pulse adds exactly one litre, forever - no drift.
  CHECK_EQ_I64(offset_ml + 10 * ML_PER_PULSE, 12345002000LL);

  // The same operation through the old float path loses the third
  // decimal outright - this is the reported "12345.001 -> 12345.000977".
  float legacy_target = 12345.001f;
  float legacy_measured = (9 * 1.0f) / 1000.0f;
  float legacy_offset = legacy_target - legacy_measured;
  float legacy_total = legacy_offset + legacy_measured;
  CHECK((double) legacy_total != 12345.001);
  // 12345.0009765625, which is what the device displayed as
  // "12345.000977" and what the reporter read as lost data.
  CHECK_EQ_I64((int64_t) llround((double) legacy_total * 1e6), 12345000977LL);

  // Flow meter: a deliberate 1 ml correction survives. An earlier round
  // snapped anything under 1e-5 m3 to zero "to avoid an ugly -0.000000"
  // and silently destroyed exactly this.
  int64_t raw_ml = 62692;
  CHECK(volume::parse_m3_to_ml("0.062691", target_ml));
  int64_t flow_offset = target_ml - raw_ml;
  CHECK_EQ_I64(flow_offset, -1);
  CHECK_EQ_I64(raw_ml + flow_offset, 62691);

  // A pulse-count rebase (packages/water_meter.yaml's interval) must not
  // change the reported total by a single millilitre.
  int64_t before = offset_ml + 8000000LL * ML_PER_PULSE;
  int64_t rebased_offset = offset_ml + 8000000LL * ML_PER_PULSE;
  int64_t after = rebased_offset + 0 * ML_PER_PULSE;
  CHECK_EQ_I64(before, after);
}

int main() {
  test_transaction_never_blocks();
  test_one_shot_takes_the_bus();
  test_transaction_timeout();
  test_transaction_outcomes();
  test_trace_flag();
  test_crc16();
  test_read_holding_registers();
  test_write_single_register_verifies_echo();
  test_address_change_is_verified_by_readback();
  test_address_change_authorization_is_exact_and_one_shot();
  test_address_change_authorization_does_not_infect_a_later_device_at_the_old_address();
  test_address_inspection_single_device();
  test_silent_fingerprint_does_not_open_a_tail_window();
  test_periodic_identity_inspector_never_blocks();
  test_periodic_identity_tail_catches_second_device();
  test_first_probe_damaged_is_not_dropped();
  test_two_full_frames_answer_the_same_request();
  test_tail_listen_catches_a_damaged_trailing_reply();
  test_probe_2_catches_a_second_round_collision();
  test_probe_1b_clean_retry_is_not_a_certain_collision();
  test_single_valid_probe_then_silence_is_not_confirmed();
  test_confirm_silence_does_not_count_as_a_clean_read();
  test_fingerprint_damage_proves_collision();
  test_header_damaged_and_crc_damaged_both_prove_collision();
  test_device_identification();
  test_scan_reports_device_types();
  test_scan_finds_every_collision_in_range();
  test_scan_collision_position_does_not_matter();
  test_scan_progress_observable_before_first_transaction();
  test_scan_double_start_is_a_noop();
  test_reconcile_scan_collisions_respects_registered_slots();
  test_reconcile_scan_collisions_asymmetric_add_vs_remove();
  test_two_different_devices_on_one_address();
  test_collision_flag_ownership();
  test_mismatch_flag_ownership();
  test_link_state_rules();
  test_transaction_handles_a_reply_trickling_in();
  test_second_reply_follows_a_genuinely_delayed_frame();
  test_read_pressure_bar();
  test_decode_flow_total_ml();
  test_read_flow_block();
  test_parse_m3_to_ml();
  test_publish_volume();
  test_publish_update_result();
  test_calibration_arithmetic();
  printf("\n%d checks, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
