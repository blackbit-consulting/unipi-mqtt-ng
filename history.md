# History

## 1.0.4 - 2026-02-09

- Support for Evok 3 (on Debian 12). Mainly removal of some messages and some renamed types.
    - Configurable under the evok options as `version: 2` vs `version: 3`

## 1.0.3 - 2026-02-09

- Signed packages via Github Attestations.
- Updated installation docs for github packages

## 1.0.2 - 2026-02-07

- Fix: Do NOT attempt to change relay states if the relay states are already in the desired state.
  This will prevent the relay from being toggled again after a restart of the application, when the application would
  reconsider the last commands from Home Assistant (as these are retained).

## 1.0.1 - 2026-02-07

- Feature: Send retained 'up' and 'down' state for buttons to MQTT broker. This will clear the previous button event
  so that the next button event will be correctly triggered without trickery in Home Assistant.