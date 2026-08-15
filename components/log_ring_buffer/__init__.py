"""Log Ring Buffer - a small, local ESPHome component (same pattern as this
repo's own components/web_server_idf fork) that keeps a bounded, RAM-only
copy of recent log lines and serves them as a downloadable plain-text file
over the existing web server (GET /log.txt).

Why RAM, not flash: direct user feedback, 2026-08-15 - the Log page
(web/dashboard.js) only ever showed whatever arrived over SSE while a
browser tab happened to be connected; the actual concern behind wanting a
"download the log" feature was that the device likely holds more log than
that, with an explicit worry that a *persistent* (flash-backed) log could
wear out the flash over time. RAM-only sidesteps that entirely - this is a
bounded ring buffer (see max_size below), lost on every reboot, same
horizon the live Log page already covers, just retroactively and
downloadable instead of only-while-connected. See REQUIREMENTS.md's own
"Log letöltés" note for the fuller reasoning, including why a
crash-survivable log (a genuinely different, much bigger feature) is
deliberately NOT what this is.

Registers itself with the logger component's log-callback mechanism
(logger::global_logger->add_log_callback(), see that header's own usage
comment) and with the existing web server's AsyncWebServer
(web_server_base::global_web_server_base->add_handler()) - no new port, no
new entity, just one more URL on the same server the dashboard already
uses.
"""

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components.logger import request_log_listener
from esphome.const import CONF_ID

CODEOWNERS = ["@eadam76"]
DEPENDENCIES = ["logger", "web_server_base"]

log_ring_buffer_ns = cg.esphome_ns.namespace("log_ring_buffer")
LogRingBuffer = log_ring_buffer_ns.class_("LogRingBuffer", cg.Component)

CONF_MAX_SIZE = "max_size"

# 16KB default: comfortably holds several hundred lines of the DEBUG-level
# output this device normally produces (see water-collector.yaml's own
# logger: comment - VERY_VERBOSE is only ever turned on temporarily, via
# the Log page's "Debug Log: Modbus" toggle, not the steady-state default),
# without eating meaningfully into the ESP32-S3's RAM budget (Free Heap is
# itself already a tracked diagnostic - see the System page).
CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(LogRingBuffer),
        # Lowercase "k" - cv.validate_bytes's METRIC_SUFFIXES is SI/case-
        # sensitive (matches Python's own convention, kilo="k" vs.
        # Kelvin="K"); "16KB" (as first written) fails validation outright
        # ("Invalid metric suffix K"), confirmed via `esphome config`.
        cv.Optional(CONF_MAX_SIZE, default="16kB"): cv.validate_bytes,
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    cg.add(var.set_max_size(config[CONF_MAX_SIZE]))
    # Reserves this component's slot in the logger's fixed-size listener
    # vector (StaticVector<LogCallback, ESPHOME_LOG_MAX_LISTENERS>) - a
    # log callback registered in C++ without a matching
    # request_log_listener() call here would silently overflow that
    # vector at runtime (undefined behavior) rather than fail to compile,
    # since the vector's capacity is sized purely from how many times this
    # function is called across every configured component. See
    # esphome/components/logger/__init__.py's own request_log_listener().
    request_log_listener()
