/*
 * Custom EcoGarden firmware with GPIO RPC and MQTT control
 * Replaces defunct cloud-dependent firmware
 */

#include "mgos.h"
#include "mgos_gpio.h"
#include "mgos_mqtt.h"
#include "mgos_rpc.h"

static int s_led_pin = 4;
static bool s_led_state = false;

// Publish sensor data over MQTT
static void sensor_timer_cb(void *arg) {
  char topic[64];
  char msg[128];

  // Simulated sensor data (original firmware had real sensors)
  float water_temp = 24.75;
  int lux = 4;

  snprintf(topic, sizeof(topic), "/devices/%s/events",
           mgos_sys_config_get_device_id());
  snprintf(msg, sizeof(msg),
           "{\"water_temperature\":%.2f,\"lux\":%d,\"led\":%s}",
           water_temp, lux, s_led_state ? "true" : "false");

  mgos_mqtt_pub(topic, msg, strlen(msg), 0, false);
  LOG(LL_INFO, ("Published: %s", msg));

  (void) arg;
}

// Set LED state
static void set_led(bool state) {
  s_led_state = state;
  // ESP8266 built-in LED is inverted (LOW = ON)
  mgos_gpio_write(s_led_pin, !state);
  LOG(LL_INFO, ("LED set to: %s", state ? "ON" : "OFF"));
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
  mg_rpc_send_responsef(ri, "{\"state\": %B}", s_led_state);

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

  if (json_scanf(msg, msg_len, "{led: %d}", &led_int) == 1) {
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

enum mgos_app_init_result mgos_app_init(void) {
  // Get LED pin from config
  s_led_pin = mgos_sys_config_get_ecogarden_led_pin();

  // Setup LED GPIO
  mgos_gpio_setup_output(s_led_pin, 1);  // Start with LED off (inverted)
  LOG(LL_INFO, ("EcoGarden firmware starting, LED pin: %d", s_led_pin));

  // Register RPC handlers
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Set", "", led_set_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Get", "", led_get_handler, NULL);
  mg_rpc_add_handler(mgos_rpc_get_global(), "LED.Toggle", "", led_toggle_handler, NULL);

  // Setup MQTT event handler for subscriptions
  mgos_mqtt_add_global_handler(mqtt_ev_handler, NULL);

  // Setup sensor publishing timer
  int interval = mgos_sys_config_get_ecogarden_sensor_interval_ms();
  mgos_set_timer(interval, MGOS_TIMER_REPEAT, sensor_timer_cb, NULL);

  LOG(LL_INFO, ("EcoGarden firmware initialized"));
  return MGOS_APP_INIT_SUCCESS;
}
