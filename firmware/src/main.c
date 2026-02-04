/*
 * Custom EcoGarden firmware with GPIO RPC, MQTT, and Home Assistant compatible HTTP hooks
 * Replaces defunct cloud-dependent firmware
 */

#include <math.h>
#include "mgos.h"
#include "mgos_gpio.h"
#include "mgos_http_server.h"
#include "mgos_i2c.h"
#include "mgos_mqtt.h"
#include "mgos_rpc.h"

// TSL2561 I2C address and registers
#define TSL2561_ADDR 0x39
#define TSL2561_CMD 0x80
#define TSL2561_REG_CONTROL 0x00
#define TSL2561_REG_DATA0 0x0C
#define TSL2561_REG_DATA1 0x0E
#define TSL2561_POWER_ON 0x03
#define TSL2561_POWER_OFF 0x00

static int s_led_pin = 4;
static bool s_led_state = false;
static float s_led_brightness = 0.0;  // 0.0 - 1.0
static bool s_auto_brightness = false;
static float s_last_lux = 0.0;
static float s_last_temp = 24.75;  // Placeholder until we find temp sensor

// Read lux value from TSL2561
static float read_tsl2561_lux(void) {
  struct mgos_i2c *i2c = mgos_i2c_get_global();
  if (i2c == NULL) {
    LOG(LL_ERROR, ("I2C not initialized"));
    return -1;
  }

  // Power on the sensor
  uint8_t cmd[2] = {TSL2561_CMD | TSL2561_REG_CONTROL, TSL2561_POWER_ON};
  if (!mgos_i2c_write(i2c, TSL2561_ADDR, cmd, 2, true)) {
    LOG(LL_ERROR, ("Failed to power on TSL2561"));
    return -1;
  }

  // Wait for conversion (402ms max integration time)
  mgos_msleep(450);

  // Read channel 0 (visible + IR)
  uint8_t reg0 = TSL2561_CMD | TSL2561_REG_DATA0;
  uint8_t data0[2] = {0};
  if (!mgos_i2c_write(i2c, TSL2561_ADDR, &reg0, 1, false) ||
      !mgos_i2c_read(i2c, TSL2561_ADDR, data0, 2, true)) {
    LOG(LL_ERROR, ("Failed to read TSL2561 channel 0"));
    return -1;
  }

  // Read channel 1 (IR only)
  uint8_t reg1 = TSL2561_CMD | TSL2561_REG_DATA1;
  uint8_t data1[2] = {0};
  if (!mgos_i2c_write(i2c, TSL2561_ADDR, &reg1, 1, false) ||
      !mgos_i2c_read(i2c, TSL2561_ADDR, data1, 2, true)) {
    LOG(LL_ERROR, ("Failed to read TSL2561 channel 1"));
    return -1;
  }

  // Power off
  cmd[1] = TSL2561_POWER_OFF;
  mgos_i2c_write(i2c, TSL2561_ADDR, cmd, 2, true);

  uint16_t ch0 = data0[0] | (data0[1] << 8);
  uint16_t ch1 = data1[0] | (data1[1] << 8);

  // Simplified lux calculation (approximate)
  if (ch0 == 0) return 0;
  float ratio = (float)ch1 / (float)ch0;
  float lux;
  if (ratio <= 0.5) {
    lux = 0.0304 * ch0 - 0.062 * ch0 * pow(ratio, 1.4);
  } else if (ratio <= 0.61) {
    lux = 0.0224 * ch0 - 0.031 * ch1;
  } else if (ratio <= 0.80) {
    lux = 0.0128 * ch0 - 0.0153 * ch1;
  } else if (ratio <= 1.30) {
    lux = 0.00146 * ch0 - 0.00112 * ch1;
  } else {
    lux = 0;
  }

  return lux;
}

// Convert lux to normalized 0-1 value (0-1000 lux range)
static float lux_to_normalized(float lux) {
  if (lux < 0) return 0;
  if (lux > 1000) return 1.0;
  return lux / 1000.0;
}

// Publish sensor data over MQTT
static void sensor_timer_cb(void *arg) {
  char topic[64];
  char msg[128];

  // Read actual light sensor
  float lux = read_tsl2561_lux();
  if (lux >= 0) {
    s_last_lux = lux;
  }

  snprintf(topic, sizeof(topic), "/devices/%s/events",
           mgos_sys_config_get_device_id());
  snprintf(msg, sizeof(msg),
           "{\"water_temperature\":%.2f,\"lux\":%.2f,\"led\":%s,\"brightness\":%.2f}",
           s_last_temp, s_last_lux, s_led_state ? "true" : "false", s_led_brightness);

  mgos_mqtt_pub(topic, msg, strlen(msg), 0, false);
  LOG(LL_INFO, ("Published: %s", msg));

  (void) arg;
}

// Set LED state (on/off)
static void set_led(bool state) {
  s_led_state = state;
  mgos_gpio_write(s_led_pin, state);  // HIGH = on for growlight
  LOG(LL_INFO, ("LED set to: %s", state ? "ON" : "OFF"));
}

// Set LED brightness (0.0 - 1.0)
static void set_led_brightness(float brightness) {
  if (brightness < 0) brightness = 0;
  if (brightness > 1) brightness = 1;
  s_led_brightness = brightness;
  s_led_state = (brightness > 0);
  // For now, just on/off (PWM could be added later)
  mgos_gpio_write(s_led_pin, s_led_state);
  LOG(LL_INFO, ("LED brightness set to: %.2f", brightness));
}

// HTTP handler for /hooks/light_sensor
static void hook_light_sensor(struct mg_connection *c, int ev, void *ev_data, void *user_data) {
  if (ev == MG_EV_HTTP_REQUEST) {
    struct http_message *hm = (struct http_message *) ev_data;
    if (mg_vcmp(&hm->uri, "/hooks/light_sensor") == 0) {
      float normalized = lux_to_normalized(s_last_lux);
      mg_send_response_line(c, 200, "Content-Type: application/json\r\n");
      mg_printf(c, "{\"value\": %.4f}\r\n", normalized);
      c->flags |= MG_F_SEND_AND_CLOSE;
    }
  }
  (void) user_data;
}

// HTTP handler for /hooks/water_temperature
static void hook_water_temp(struct mg_connection *c, int ev, void *ev_data, void *user_data) {
  if (ev == MG_EV_HTTP_REQUEST) {
    struct http_message *hm = (struct http_message *) ev_data;
    if (mg_vcmp(&hm->uri, "/hooks/water_temperature") == 0) {
      mg_send_response_line(c, 200, "Content-Type: application/json\r\n");
      mg_printf(c, "{\"value\": %.2f}\r\n", s_last_temp);
      c->flags |= MG_F_SEND_AND_CLOSE;
    }
  }
  (void) user_data;
}

// HTTP handler for /hooks/set_led_brightness
static void hook_set_brightness(struct mg_connection *c, int ev, void *ev_data, void *user_data) {
  if (ev == MG_EV_HTTP_REQUEST) {
    struct http_message *hm = (struct http_message *) ev_data;
    if (mg_vcasecmp(&hm->uri, "/hooks/set_led_brightness") == 0) {
      char value[16] = {0};
      if (mg_get_http_var(&hm->query_string, "value", value, sizeof(value)) > 0) {
        float brightness = atof(value);
        set_led_brightness(brightness);
        mg_send_response_line(c, 200, "Content-Type: application/json\r\n");
        mg_printf(c, "{\"ok\": true, \"value\": %.2f}\r\n", brightness);
      } else {
        mg_send_response_line(c, 400, "Content-Type: application/json\r\n");
        mg_printf(c, "{\"error\": \"value parameter required\"}\r\n");
      }
      c->flags |= MG_F_SEND_AND_CLOSE;
    }
  }
  (void) user_data;
}

// HTTP handler for /hooks/set_automatic_led_brightness
static void hook_auto_brightness(struct mg_connection *c, int ev, void *ev_data, void *user_data) {
  if (ev == MG_EV_HTTP_REQUEST) {
    struct http_message *hm = (struct http_message *) ev_data;
    if (mg_vcasecmp(&hm->uri, "/hooks/set_automatic_led_brightness") == 0) {
      char value[16] = {0};
      if (mg_get_http_var(&hm->query_string, "value", value, sizeof(value)) > 0) {
        s_auto_brightness = (atoi(value) != 0);
        mg_send_response_line(c, 200, "Content-Type: application/json\r\n");
        mg_printf(c, "{\"ok\": true, \"auto\": %s}\r\n", s_auto_brightness ? "true" : "false");
      } else {
        mg_send_response_line(c, 400, "Content-Type: application/json\r\n");
        mg_printf(c, "{\"error\": \"value parameter required\"}\r\n");
      }
      c->flags |= MG_F_SEND_AND_CLOSE;
    }
  }
  (void) user_data;
}

// HTTP handler for /hooks/feed_now (stub - feeder GPIO unknown)
static void hook_feed_now(struct mg_connection *c, int ev, void *ev_data, void *user_data) {
  if (ev == MG_EV_HTTP_REQUEST) {
    struct http_message *hm = (struct http_message *) ev_data;
    if (mg_vcmp(&hm->uri, "/hooks/feed_now") == 0) {
      LOG(LL_INFO, ("Feed requested (feeder GPIO not yet discovered)"));
      // TODO: Trigger feeder when GPIO is discovered
      mg_send_response_line(c, 200, "Content-Type: application/json\r\n");
      mg_printf(c, "{\"ok\": true, \"note\": \"feeder not yet implemented\"}\r\n");
      c->flags |= MG_F_SEND_AND_CLOSE;
    }
  }
  (void) user_data;
}

// RPC handler for LED.Set
static void led_set_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                            struct mg_rpc_frame_info *fi, struct mg_str args) {
  bool state = false;

  if (json_scanf(args.p, args.len, "{state: %B}", &state) == 1) {
    set_led(state);
    mg_rpc_send_responsef(ri, "{\"ok\": true, \"state\": %B}", state);
  } else {
    mg_rpc_send_errorf(ri, 400, "state is required");
  }

  (void) cb_arg;
  (void) fi;
}

// RPC handler for LED.Get
static void led_get_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                            struct mg_rpc_frame_info *fi, struct mg_str args) {
  mg_rpc_send_responsef(ri, "{\"state\": %B, \"brightness\": %.2f}", s_led_state, s_led_brightness);

  (void) cb_arg;
  (void) fi;
  (void) args;
}

// RPC handler for LED.Toggle
static void led_toggle_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                               struct mg_rpc_frame_info *fi, struct mg_str args) {
  set_led(!s_led_state);
  mg_rpc_send_responsef(ri, "{\"ok\": true, \"state\": %B}", s_led_state);

  (void) cb_arg;
  (void) fi;
  (void) args;
}

// MQTT subscription handler for config topic
static void mqtt_sub_handler(struct mg_connection *nc, const char *topic,
                             int topic_len, const char *msg, int msg_len,
                             void *ud) {
  LOG(LL_INFO, ("MQTT msg: %.*s -> %.*s", topic_len, topic, msg_len, msg));

  // Parse LED commands: {"led": 1} or {"led": true} or {"on": true}
  int led_int = -1;
  bool led_bool = false;
  bool on_bool = false;
  double brightness = -1;

  if (json_scanf(msg, msg_len, "{brightness: %lf}", &brightness) == 1) {
    set_led_brightness((float)brightness);
  } else if (json_scanf(msg, msg_len, "{led: %d}", &led_int) == 1) {
    set_led(led_int != 0);
  } else if (json_scanf(msg, msg_len, "{led: %B}", &led_bool) == 1) {
    set_led(led_bool);
  } else if (json_scanf(msg, msg_len, "{on: %B}", &on_bool) == 1) {
    set_led(on_bool);
  }

  (void) nc;
  (void) ud;
}

// MQTT event handler for subscribing to topics
static void mqtt_ev_handler(struct mg_connection *nc, int ev, void *ev_data,
                            void *user_data) {
  if (ev == MG_EV_MQTT_CONNACK) {
    char topic[64];
    snprintf(topic, sizeof(topic), "/devices/%s/config",
             mgos_sys_config_get_device_id());
    mgos_mqtt_sub(topic, mqtt_sub_handler, NULL);
    LOG(LL_INFO, ("Subscribed to: %s", topic));

    // Also subscribe to commands topic
    snprintf(topic, sizeof(topic), "/devices/%s/commands/#",
             mgos_sys_config_get_device_id());
    mgos_mqtt_sub(topic, mqtt_sub_handler, NULL);
    LOG(LL_INFO, ("Subscribed to: %s", topic));
  }

  (void) nc;
  (void) ev_data;
  (void) user_data;
}

// Main HTTP event handler to route /hooks/* requests
static void http_handler(struct mg_connection *c, int ev, void *ev_data, void *user_data) {
  if (ev == MG_EV_HTTP_REQUEST) {
    struct http_message *hm = (struct http_message *) ev_data;

    if (mg_vcmp(&hm->uri, "/hooks/light_sensor") == 0) {
      hook_light_sensor(c, ev, ev_data, user_data);
    } else if (mg_vcmp(&hm->uri, "/hooks/water_temperature") == 0) {
      hook_water_temp(c, ev, ev_data, user_data);
    } else if (mg_vcasecmp(&hm->uri, "/hooks/set_led_brightness") == 0) {
      hook_set_brightness(c, ev, ev_data, user_data);
    } else if (mg_vcasecmp(&hm->uri, "/hooks/set_automatic_led_brightness") == 0) {
      hook_auto_brightness(c, ev, ev_data, user_data);
    } else if (mg_vcmp(&hm->uri, "/hooks/feed_now") == 0) {
      hook_feed_now(c, ev, ev_data, user_data);
    }
    // Other URIs handled by default Mongoose OS HTTP server
  }
  (void) user_data;
}

enum mgos_app_init_result mgos_app_init(void) {
  // Get LED pin from config
  s_led_pin = mgos_sys_config_get_ecogarden_led_pin();

  // Setup LED GPIO
  mgos_gpio_setup_output(s_led_pin, 0);  // Start with LED off
  LOG(LL_INFO, ("EcoGarden firmware starting, LED pin: %d", s_led_pin));

  // Initial sensor read
  float lux = read_tsl2561_lux();
  if (lux >= 0) {
    s_last_lux = lux;
    LOG(LL_INFO, ("Initial light reading: %.2f lux", lux));
  }

  // Register RPC handlers
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Set", "", led_set_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Get", "", led_get_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Toggle", "", led_toggle_handler, NULL);

  // Register HTTP handlers for /hooks/* endpoints
  mgos_register_http_endpoint("/hooks/", http_handler, NULL);

  // Setup MQTT event handler for subscriptions
  mgos_mqtt_add_global_handler(mqtt_ev_handler, NULL);

  // Setup sensor publishing timer
  int interval = mgos_sys_config_get_ecogarden_sensor_interval_ms();
  mgos_set_timer(interval, MGOS_TIMER_REPEAT, sensor_timer_cb, NULL);

  LOG(LL_INFO, ("EcoGarden firmware initialized with Home Assistant hooks"));
  return MGOS_APP_INIT_SUCCESS;
}
