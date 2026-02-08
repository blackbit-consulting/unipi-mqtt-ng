# Planned features

* Support for mapping Evok inputs to other HA digital inputs:
    * Contact sensor
    * Motion sensor
    * Binary sensor
    * ... there are plenty of options [here](https://www.home-assistant.io/integrations/binary_sensor/)
* Support for analog inputs (e.g. potentiometer, light sensor, etc.)
* Support for the Unipi LEDS
* Identify support to indicate which Evok device is being addressed
* Unit and integration tests

# Development principles

This application was explicitly written to be as simple and efficient as possible.
Therefore I did not write this as OO code but just with functions and state in scripts.

I might change this in the future if this adds extra clarity and testability.