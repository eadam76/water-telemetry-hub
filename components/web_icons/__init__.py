"""Web Icons - a small local ESPHome component (same pattern as this repo's
own components/log_ring_buffer) that serves the dashboard's icons from
flash over the existing web server:

  GET /favicon.svg                   the browser-tab icon
  GET /apple-touch-icon.png          the iOS/Android home-screen icon
  GET /apple-touch-icon-precomposed.png   (older iOS asks for this name)

Why served files and not data: URIs inside web/dashboard.js: the favicon
would work either way, but iOS ignores a data: URI in an apple-touch-icon
link and falls back to a blurred screenshot of the page - and that icon
is the whole reason the dashboard carries a logo at all, since it already
declares apple-mobile-web-app-capable and launches full-screen from the
home screen. iOS also fetches /apple-touch-icon.png from the site root
on its own, so serving it at exactly that path works even before the
page has run a line of script.

The files are embedded at build time from the paths in the config (the
same relative-to-the-YAML resolution web_server: uses for js_include),
so the SVG source and the PNG stay ordinary files in web/icons/ and the
firmware carries a byte-for-byte copy. No new port, no new entity - one
handler on the same AsyncWebServer the dashboard already uses.
"""

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.const import CONF_ID
from esphome.core import CORE, HexInt

CODEOWNERS = ["@eadam76"]
DEPENDENCIES = ["web_server_base"]

web_icons_ns = cg.esphome_ns.namespace("web_icons")
WebIcons = web_icons_ns.class_("WebIcons", cg.Component)

CONF_FAVICON_SVG = "favicon_svg"
CONF_APPLE_TOUCH_ICON = "apple_touch_icon"
CONF_FAVICON_DATA_ID = "favicon_data_id"
CONF_TOUCH_ICON_DATA_ID = "touch_icon_data_id"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(WebIcons),
        cv.Required(CONF_FAVICON_SVG): cv.file_,
        cv.Required(CONF_APPLE_TOUCH_ICON): cv.file_,
        # The two byte arrays get their own ids so they land in flash as
        # named PROGMEM arrays (cg.progmem_array), the way the font
        # component embeds glyph bitmaps - not on the heap, not in RAM.
        cv.GenerateID(CONF_FAVICON_DATA_ID): cv.declare_id(cg.uint8),
        cv.GenerateID(CONF_TOUCH_ICON_DATA_ID): cv.declare_id(cg.uint8),
    }
).extend(cv.COMPONENT_SCHEMA)


def _embed(id_, path):
    data = CORE.relative_config_path(path).read_bytes()
    return cg.progmem_array(id_, [HexInt(b) for b in data]), len(data)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    favicon, favicon_size = _embed(config[CONF_FAVICON_DATA_ID], config[CONF_FAVICON_SVG])
    cg.add(var.set_favicon_svg(favicon, favicon_size))
    touch, touch_size = _embed(config[CONF_TOUCH_ICON_DATA_ID], config[CONF_APPLE_TOUCH_ICON])
    cg.add(var.set_apple_touch_icon(touch, touch_size))
