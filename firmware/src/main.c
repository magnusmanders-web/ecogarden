/*
 * Custom EcoGarden firmware - v1.3.0
 * GPIO RPC, MQTT, and Home Assistant compatible HTTP hooks
 * DS18B20 temperature sensor on GPIO 13
 * TSL2561 light sensor on I2C 0x39
 * Growlight on GPIO 4
 * Feeder test on GPIO 15
 */

#include <math.h>
#include "mgos.h"
#include "mgos_gpio.h"
#include "mgos_http_server.h"
#include "mgos_i2c.h"
#include "mgos_mqtt.h"
#include "mgos_rpc.h"
#include "mgos_onewire.h"

// DS18B20 1-Wire temperature sensor
#define DS18B20_FAMILY_CODE 0x28
#define DS18B20_CMD_CONVERT 0x44
#define DS18B20_CMD_READ_SCRATCHPAD 0xBE

static struct mgos_onewire *s_onewire = NULL;
static uint8_t s_ds18b20_addr[8] = {0};
static bool s_ds18b20_found = false;

// TSL2561 I2C light sensor
#define TSL2561_ADDR 0x39
#define TSL2561_CMD 0x80
#define TSL2561_REG_CONTROL 0x00
#define TSL2561_REG_DATA0 0x0C
#define TSL2561_REG_DATA1 0x0E
#define TSL2561_POWER_ON 0x03
#define TSL2561_POWER_OFF 0x00

// Device state
static int s_led_pin = 4;
static int s_feeder_pin = 15;
static bool s_led_state = false;
static float s_led_brightness = 0.0;
static bool s_auto_brightness = false;
static float s_last_lux = 0.0;
static float s_last_temp = 0.0;

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

// Read temperature from DS18B20 via 1-Wire
static float read_ds18b20_temp(void) {
  if (s_onewire == NULL || !s_ds18b20_found) return s_last_temp;

  // Start conversion
  mgos_onewire_reset(s_onewire);
  mgos_onewire_select(s_onewire, s_ds18b20_addr);
  mgos_onewire_write(s_onewire, DS18B20_CMD_CONVERT);
  mgos_msleep(750);  // Wait for 12-bit conversion

  // Read scratchpad
  mgos_onewire_reset(s_onewire);
  mgos_onewire_select(s_onewire, s_ds18b20_addr);
  mgos_onewire_write(s_onewire, DS18B20_CMD_READ_SCRATCHPAD);

  uint8_t data[9];
  for (int i = 0; i < 9; i++) {
    data[i] = mgos_onewire_read(s_onewire);
  }

  int16_t raw = (data[1] << 8) | data[0];
  float temp = raw / 16.0;

  if (temp < -55 || temp > 125) return s_last_temp;  // Invalid reading
  return temp;
}

// Initialize DS18B20 temperature sensor on configured 1-Wire pin
static void init_ds18b20(void) {
  int pin = mgos_sys_config_get_ecogarden_onewire_pin();
  LOG(LL_INFO, ("Scanning 1-Wire on GPIO %d...", pin));

  s_onewire = mgos_onewire_create(pin);
  if (s_onewire == NULL) {
    LOG(LL_ERROR, ("Failed to init 1-Wire on GPIO %d", pin));
    return;
  }

  mgos_onewire_search_clean(s_onewire);
  uint8_t addr[8];
  while (mgos_onewire_next(s_onewire, addr, 0)) {
    if (addr[0] == DS18B20_FAMILY_CODE) {
      memcpy(s_ds18b20_addr, addr, 8);
      s_ds18b20_found = true;
      LOG(LL_INFO, ("DS18B20 found: %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X",
          addr[0], addr[1], addr[2], addr[3], addr[4], addr[5], addr[6], addr[7]));
      break;
    }
  }

  if (!s_ds18b20_found) {
    LOG(LL_WARN, ("No DS18B20 found on GPIO %d", pin));
  }
}

// Publish sensor data over MQTT
static void sensor_timer_cb(void *arg) {
  char topic[64];
  char msg[128];

  // Read light sensor
  float lux = read_tsl2561_lux();
  if (lux >= 0) {
    s_last_lux = lux;
  }

  // Read temperature sensor
  if (s_ds18b20_found) {
    float temp = read_ds18b20_temp();
    if (temp > -55 && temp < 125) {
      s_last_temp = temp;
    }
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

// --- HTTP Hook Handlers ---

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

// HTTP handler for /hooks/feed_now - pulse feeder GPIO
static void hook_feed_now(struct mg_connection *c, int ev, void *ev_data, void *user_data) {
  if (ev == MG_EV_HTTP_REQUEST) {
    struct http_message *hm = (struct http_message *) ev_data;
    if (mg_vcmp(&hm->uri, "/hooks/feed_now") == 0) {
      LOG(LL_INFO, ("Feed requested - pulsing GPIO %d", s_feeder_pin));
      mgos_gpio_setup_output(s_feeder_pin, 0);
      mgos_gpio_write(s_feeder_pin, 1);
      mgos_msleep(2000);  // 2-second pulse
      mgos_gpio_write(s_feeder_pin, 0);
      mg_send_response_line(c, 200, "Content-Type: application/json\r\n");
      mg_printf(c, "{\"ok\": true, \"pin\": %d, \"pulse_ms\": 2000}\r\n", s_feeder_pin);
      c->flags |= MG_F_SEND_AND_CLOSE;
    }
  }
  (void) user_data;
}

// --- RPC Handlers ---

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

// RPC handler for Temp.Scan - scan 1-Wire bus for DS18B20
static void temp_scan_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                              struct mg_rpc_frame_info *fi, struct mg_str args) {
  int pin = mgos_sys_config_get_ecogarden_onewire_pin();

  if (s_onewire == NULL) {
    s_onewire = mgos_onewire_create(pin);
  }

  if (s_onewire == NULL) {
    mg_rpc_send_responsef(ri, "{\"found\": false, \"pin\": %d, \"error\": \"Failed to init 1-Wire\"}", pin);
    goto out;
  }

  mgos_onewire_search_clean(s_onewire);

  uint8_t addr[8];
  int count = 0;
  char addr_str[24] = {0};

  while (mgos_onewire_next(s_onewire, addr, 0)) {
    if (addr[0] != DS18B20_FAMILY_CODE) continue;
    snprintf(addr_str, sizeof(addr_str), "%02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X",
             addr[0], addr[1], addr[2], addr[3], addr[4], addr[5], addr[6], addr[7]);
    LOG(LL_INFO, ("DS18B20 found at: %s", addr_str));

    if (count == 0) {
      memcpy(s_ds18b20_addr, addr, 8);
      s_ds18b20_found = true;
    }
    count++;
  }

  if (count > 0) {
    float temp = read_ds18b20_temp();
    s_last_temp = temp;
    mg_rpc_send_responsef(ri, "{\"found\": true, \"count\": %d, \"pin\": %d, \"address\": \"%s\", \"temperature\": %.2f}",
                          count, pin, addr_str, temp);
  } else {
    mg_rpc_send_responsef(ri, "{\"found\": false, \"pin\": %d, \"count\": 0}", pin);
  }

out:
  (void) cb_arg;
  (void) fi;
  (void) args;
}

// RPC handler for Temp.Read - read temperature
static void temp_read_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                              struct mg_rpc_frame_info *fi, struct mg_str args) {
  float temp = s_ds18b20_found ? read_ds18b20_temp() : s_last_temp;
  mg_rpc_send_responsef(ri, "{\"temperature\": %.2f, \"sensor_found\": %B}",
                        temp, s_ds18b20_found);
  (void) cb_arg;
  (void) fi;
  (void) args;
}

// --- MQTT Handlers ---

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

// --- HTTP Dispatcher ---

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

// --- App Init ---

enum mgos_app_init_result mgos_app_init(void) {
  // Get config
  s_led_pin = mgos_sys_config_get_ecogarden_led_pin();
  s_feeder_pin = 15;  // GPIO 15 - freed from UART1, testing for feeder

  // Setup LED GPIO and turn on at boot
  mgos_gpio_setup_output(s_led_pin, 1);  // Start with LED on
  s_led_state = true;
  s_led_brightness = 1.0;
  LOG(LL_INFO, ("EcoGarden firmware v1.3.0, LED pin: %d (ON)", s_led_pin));

  // Initialize DS18B20 temperature sensor on 1-Wire bus
  init_ds18b20();

  // Initial light sensor read
  float lux = read_tsl2561_lux();
  if (lux >= 0) {
    s_last_lux = lux;
    LOG(LL_INFO, ("Initial light: %.2f lux", lux));
  }

  // Register LED RPC handlers
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Set", "", led_set_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Get", "", led_get_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Toggle", "", led_toggle_handler, NULL);

  // Register temperature sensor RPC handlers
  mg_rpc_add_handler(mgos_rpc_get_global(), "Temp.Scan", "", temp_scan_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "Temp.Read", "", temp_read_handler, NULL);

  // Register HTTP handlers for /hooks/* endpoints
  mgos_register_http_endpoint("/hooks/", http_handler, NULL);

  // Setup MQTT event handler for subscriptions
  mgos_mqtt_add_global_handler(mqtt_ev_handler, NULL);

  // Setup sensor publishing timer
  int interval = mgos_sys_config_get_ecogarden_sensor_interval_ms();
  mgos_set_timer(interval, MGOS_TIMER_REPEAT, sensor_timer_cb, NULL);

  LOG(LL_INFO, ("EcoGarden initialized. DS18B20: %s, feeder GPIO: %d",
      s_ds18b20_found ? "found" : "not found", s_feeder_pin));
  return MGOS_APP_INIT_SUCCESS;
}
