/*
 * Custom EcoGarden firmware with GPIO RPC, MQTT, and Home Assistant compatible HTTP hooks
 * Replaces defunct cloud-dependent firmware
 * Now with TuyaMCU support for secondary MCU communication
 */

#include <math.h>
#include "mgos.h"
#include "mgos_gpio.h"
#include "mgos_http_server.h"
#include "mgos_i2c.h"
#include "mgos_mqtt.h"
#include "mgos_rpc.h"
#include "mgos_uart.h"
// #include "mgos_onewire.h"  // Disabled to reduce memory for OTA

// DS18B20 1-Wire temperature sensor - DISABLED
// #define DS18B20_FAMILY_CODE 0x28
// #define DS18B20_CMD_CONVERT 0x44
// #define DS18B20_CMD_READ_SCRATCHPAD 0xBE

// static struct mgos_onewire *s_onewire = NULL;
// static uint8_t s_ds18b20_addr[8] = {0};
static bool s_ds18b20_found = false;  // Always false when onewire disabled

// TuyaMCU protocol constants
#define TUYA_HEADER_1 0x55
#define TUYA_HEADER_2 0xAA
#define TUYA_CMD_HEARTBEAT 0x00
#define TUYA_CMD_QUERY_PRODUCT 0x01
#define TUYA_CMD_QUERY_STATE 0x08
#define TUYA_CMD_SEND_CMD 0x06

// MCU UART state
static int s_mcu_uart = -1;
static uint8_t s_mcu_rx_buf[256];
static int s_mcu_rx_len = 0;
static bool s_mcu_detected = false;

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

// 1-Wire/DS18B20 functions - DISABLED to reduce memory for OTA
// Will be re-enabled once we confirm temp sensor exists

static float read_ds18b20_temp(void) {
  return s_last_temp;  // Return placeholder
}

// Calculate TuyaMCU checksum (sum of all bytes mod 256)
static uint8_t tuya_checksum(uint8_t *data, int len) {
  uint8_t sum = 0;
  for (int i = 0; i < len; i++) {
    sum += data[i];
  }
  return sum;
}

// Send TuyaMCU command
static bool tuya_send_cmd(uint8_t cmd, uint8_t *data, int data_len) {
  if (s_mcu_uart < 0) return false;

  int pkt_len = 6 + data_len + 1;  // header(2) + ver(1) + cmd(1) + len(2) + data + checksum(1)
  uint8_t *pkt = (uint8_t *)malloc(pkt_len);
  if (!pkt) return false;

  pkt[0] = TUYA_HEADER_1;
  pkt[1] = TUYA_HEADER_2;
  pkt[2] = 0x00;  // version
  pkt[3] = cmd;
  pkt[4] = (data_len >> 8) & 0xFF;  // length high byte
  pkt[5] = data_len & 0xFF;         // length low byte
  if (data_len > 0 && data != NULL) {
    memcpy(&pkt[6], data, data_len);
  }
  pkt[pkt_len - 1] = tuya_checksum(pkt, pkt_len - 1);

  LOG(LL_INFO, ("TuyaMCU TX: cmd=0x%02X len=%d", cmd, data_len));

  // Log the packet bytes for debugging
  char hex[128] = {0};
  int hex_len = 0;
  for (int i = 0; i < pkt_len && hex_len < 120; i++) {
    hex_len += snprintf(hex + hex_len, sizeof(hex) - hex_len, "%02X ", pkt[i]);
  }
  LOG(LL_DEBUG, ("TuyaMCU packet: %s", hex));

  size_t written = mgos_uart_write(s_mcu_uart, pkt, pkt_len);
  free(pkt);

  return written == (size_t)pkt_len;
}

// Send TuyaMCU heartbeat to detect MCU
static bool tuya_heartbeat(void) {
  return tuya_send_cmd(TUYA_CMD_HEARTBEAT, NULL, 0);
}

// Send TuyaMCU query state command
static bool tuya_query_state(void) {
  return tuya_send_cmd(TUYA_CMD_QUERY_STATE, NULL, 0);
}

// Send TuyaMCU datapoint command (for controlling relays, motors, etc.)
// dpid: datapoint ID, type: 1=bool, 2=int, 4=string, value: the value
static bool tuya_send_dp_bool(uint8_t dpid, bool value) {
  uint8_t data[5];
  data[0] = dpid;        // dpId
  data[1] = 0x01;        // type: bool
  data[2] = 0x00;        // length high
  data[3] = 0x01;        // length low
  data[4] = value ? 0x01 : 0x00;
  return tuya_send_cmd(TUYA_CMD_SEND_CMD, data, 5);
}

// UART RX callback to receive MCU responses
static void mcu_uart_rx_cb(int uart_no, void *arg) {
  size_t avail = mgos_uart_read_avail(uart_no);
  if (avail == 0) return;

  size_t to_read = avail;
  if (s_mcu_rx_len + to_read > sizeof(s_mcu_rx_buf)) {
    to_read = sizeof(s_mcu_rx_buf) - s_mcu_rx_len;
  }

  size_t read = mgos_uart_read(uart_no, &s_mcu_rx_buf[s_mcu_rx_len], to_read);
  s_mcu_rx_len += read;

  // Log received data
  char hex[128] = {0};
  int hex_len = 0;
  for (int i = 0; i < s_mcu_rx_len && hex_len < 120; i++) {
    hex_len += snprintf(hex + hex_len, sizeof(hex) - hex_len, "%02X ", s_mcu_rx_buf[i]);
  }
  LOG(LL_INFO, ("TuyaMCU RX (%d bytes): %s", s_mcu_rx_len, hex));

  // Check for valid TuyaMCU response (starts with 55 AA)
  if (s_mcu_rx_len >= 2 && s_mcu_rx_buf[0] == TUYA_HEADER_1 && s_mcu_rx_buf[1] == TUYA_HEADER_2) {
    s_mcu_detected = true;
    LOG(LL_INFO, ("TuyaMCU response detected!"));
  }

  // Clear buffer after processing
  if (s_mcu_rx_len > 64) {
    s_mcu_rx_len = 0;
  }

  (void) arg;
}

// Initialize MCU UART
static void init_mcu_uart(void) {
  int uart_no = mgos_sys_config_get_ecogarden_mcu_uart();

  struct mgos_uart_config cfg;
  mgos_uart_config_set_defaults(uart_no, &cfg);
  cfg.baud_rate = 9600;
  cfg.num_data_bits = 8;
  cfg.parity = MGOS_UART_PARITY_NONE;
  cfg.stop_bits = MGOS_UART_STOP_BITS_1;
  cfg.rx_buf_size = 256;
  cfg.tx_buf_size = 256;

  if (!mgos_uart_configure(uart_no, &cfg)) {
    LOG(LL_ERROR, ("Failed to configure UART%d for MCU", uart_no));
    return;
  }

  mgos_uart_set_dispatcher(uart_no, mcu_uart_rx_cb, NULL);
  mgos_uart_set_rx_enabled(uart_no, true);

  s_mcu_uart = uart_no;
  LOG(LL_INFO, ("MCU UART%d initialized at 9600 baud", uart_no));
}

// Trigger feeder via TuyaMCU (try common dpIds)
static bool trigger_feeder_mcu(void) {
  if (s_mcu_uart < 0) {
    LOG(LL_WARN, ("MCU UART not initialized"));
    return false;
  }

  LOG(LL_INFO, ("Attempting to trigger feeder via TuyaMCU..."));

  // Try common datapoint IDs used for feeders/relays
  // dpId 1 is often used for on/off or trigger
  tuya_send_dp_bool(1, true);
  mgos_msleep(100);

  // dpId 3 is sometimes used for motor control
  tuya_send_dp_bool(3, true);
  mgos_msleep(100);

  // dpId 101-104 are custom dpIds often used by manufacturers
  tuya_send_dp_bool(101, true);
  mgos_msleep(100);

  return true;
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

  // Read temperature from DS18B20 if found
  if (s_ds18b20_found) {
    float temp = read_ds18b20_temp();
    if (temp > -100) {  // Valid reading
      s_last_temp = temp;
    }
  }

  snprintf(topic, sizeof(topic), "/devices/%s/events",
           mgos_sys_config_get_device_id());
  snprintf(msg, sizeof(msg),
           "{\"water_temperature\":%.2f,\"lux\":%.2f,\"led\":%s,\"brightness\":%.2f,\"temp_sensor\":%s}",
           s_last_temp, s_last_lux, s_led_state ? "true" : "false", s_led_brightness,
           s_ds18b20_found ? "true" : "false");

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

// HTTP handler for /hooks/feed_now - tries TuyaMCU
static void hook_feed_now(struct mg_connection *c, int ev, void *ev_data, void *user_data) {
  if (ev == MG_EV_HTTP_REQUEST) {
    struct http_message *hm = (struct http_message *) ev_data;
    if (mg_vcmp(&hm->uri, "/hooks/feed_now") == 0) {
      LOG(LL_INFO, ("Feed requested - trying TuyaMCU"));
      bool sent = trigger_feeder_mcu();
      mg_send_response_line(c, 200, "Content-Type: application/json\r\n");
      mg_printf(c, "{\"ok\": true, \"mcu_cmd_sent\": %s, \"mcu_detected\": %s}\r\n",
                sent ? "true" : "false", s_mcu_detected ? "true" : "false");
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

// RPC handler for MCU.Heartbeat - send TuyaMCU heartbeat
static void mcu_heartbeat_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                                  struct mg_rpc_frame_info *fi, struct mg_str args) {
  bool sent = tuya_heartbeat();
  mg_rpc_send_responsef(ri, "{\"ok\": true, \"sent\": %B, \"mcu_detected\": %B}",
                        sent, s_mcu_detected);
  (void) cb_arg;
  (void) fi;
  (void) args;
}

// RPC handler for MCU.Query - query MCU state
static void mcu_query_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                              struct mg_rpc_frame_info *fi, struct mg_str args) {
  bool sent = tuya_query_state();
  mg_rpc_send_responsef(ri, "{\"ok\": true, \"sent\": %B, \"mcu_detected\": %B}",
                        sent, s_mcu_detected);
  (void) cb_arg;
  (void) fi;
  (void) args;
}

// RPC handler for MCU.SendDP - send datapoint command
static void mcu_send_dp_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                                struct mg_rpc_frame_info *fi, struct mg_str args) {
  int dpid = 1;
  int value = 1;
  json_scanf(args.p, args.len, "{dpid: %d, value: %d}", &dpid, &value);

  bool sent = tuya_send_dp_bool((uint8_t)dpid, value != 0);
  mg_rpc_send_responsef(ri, "{\"ok\": true, \"sent\": %B, \"dpid\": %d, \"value\": %d}",
                        sent, dpid, value);
  (void) cb_arg;
  (void) fi;
}

// RPC handler for MCU.Feed - trigger feeder
static void mcu_feed_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                             struct mg_rpc_frame_info *fi, struct mg_str args) {
  bool sent = trigger_feeder_mcu();
  mg_rpc_send_responsef(ri, "{\"ok\": true, \"sent\": %B, \"mcu_detected\": %B}",
                        sent, s_mcu_detected);
  (void) cb_arg;
  (void) fi;
  (void) args;
}

// RPC handler for Temp.Scan - disabled, 1-Wire not compiled in
static void temp_scan_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                              struct mg_rpc_frame_info *fi, struct mg_str args) {
  mg_rpc_send_responsef(ri, "{\"found\": false, \"address\": \"disabled\", \"message\": \"1-Wire disabled to reduce memory\"}");
  (void) cb_arg;
  (void) fi;
  (void) args;
}

// RPC handler for Temp.Read - read temperature
static void temp_read_handler(struct mg_rpc_request_info *ri, void *cb_arg,
                              struct mg_rpc_frame_info *fi, struct mg_str args) {
  float temp = s_ds18b20_found ? read_ds18b20_temp() : s_last_temp;
  mg_rpc_send_responsef(ri, "{\"temperature\": %.2f, \"sensor_found\": %B, \"is_placeholder\": %B}",
                        temp, s_ds18b20_found, !s_ds18b20_found);
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

  // Setup LED GPIO and turn on at boot
  mgos_gpio_setup_output(s_led_pin, 1);  // Start with LED on
  s_led_state = true;
  s_led_brightness = 1.0;
  LOG(LL_INFO, ("EcoGarden firmware starting, LED pin: %d (ON)", s_led_pin));

  // Initialize MCU UART for TuyaMCU communication
  init_mcu_uart();

  // Initial sensor read
  float lux = read_tsl2561_lux();
  if (lux >= 0) {
    s_last_lux = lux;
    LOG(LL_INFO, ("Initial light reading: %.2f lux", lux));
  }

  // 1-Wire disabled to save memory - using placeholder temp
  LOG(LL_INFO, ("1-Wire disabled, using placeholder temp: %.2f C", s_last_temp));

  // Register LED RPC handlers
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Set", "", led_set_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Get", "", led_get_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Toggle", "", led_toggle_handler, NULL);

  // Register MCU RPC handlers for TuyaMCU testing
  mg_rpc_add_handler(mgos_rpc_get_global(), "MCU.Heartbeat", "", mcu_heartbeat_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "MCU.Query", "", mcu_query_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "MCU.SendDP", "{dpid: %d, value: %d}", mcu_send_dp_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "MCU.Feed", "", mcu_feed_handler, NULL);

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

  // Send initial MCU heartbeat after 2 seconds to detect secondary MCU
  mgos_set_timer(2000, 0, (void (*)(void *))tuya_heartbeat, NULL);

  LOG(LL_INFO, ("EcoGarden firmware initialized with TuyaMCU support"));
  return MGOS_APP_INIT_SUCCESS;
}
