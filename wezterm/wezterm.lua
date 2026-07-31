local wezterm = require("wezterm")
local config = wezterm.config_builder()

config.color_scheme = 'SpaceGray Eighties'
config.font = wezterm.font("Hack Nerd Font", { weight = "DemiBold" })
config.font_size = 18.0
config.max_fps = 120

config.window_decorations = "INTEGRATED_BUTTONS|RESIZE"
config.window_padding = {
  left = 16,
  right = 16,
  top = 6,
  bottom = 6,
}

config.inactive_pane_hsb = {
  saturation = 0.0,
  brightness = 0.5,
}

return config
