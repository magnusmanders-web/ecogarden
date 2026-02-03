load("api_gpio.js");
load("api_rpc.js");
let led = 2;
GPIO.set_mode(led, GPIO.MODE_OUTPUT);
RPC.addHandler("LED.Set", function(args) {
  GPIO.write(led, args.state ? 1 : 0);
  return true;
});