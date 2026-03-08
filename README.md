# ioBroker.duosidaems

Custom ioBroker adapter for older **Duosida / SmartCharge / DS Charge** wallboxes.  
It supports:

- **local TCP control** for SmartCharge-style devices (`TCP 9988`, UDP discovery `48890 → 48899`)
- **X-Cheng cloud control** for older app-bound variants
- **auto mode** (`local` first, then cloud fallback)
- **EMS-friendly writable states** for current control, start/stop and basic charger settings

> **Quick German note**
>
> - **1 Instanz = 1 Wallbox**
> - Eine kompakte Datenpunktübersicht findest du in [DATAPOINTS.md](./DATAPOINTS.md)
> - Dein EMS schreibt hauptsächlich auf  
>   `duosidaems.0.charger.control.maxCurrent`  
>   `duosidaems.0.charger.control.start`  
>   `duosidaems.0.charger.control.stop`
> - Für ältere „nur App“-Modelle stelle den Transport auf `auto` oder `cloud`.

## What this adapter is for

The main target is exactly the use case you described:

- older Duosida wallboxes
- no OCPP
- app-based binding
- current limit should be controlled from an EMS / PV logic inside ioBroker

## Current feature set

### Local TCP transport

- startup discovery via UDP broadcast
- direct TCP status polling
- read:
  - state / state code
  - voltage
  - current
  - power
  - station temperature
  - internal temperature
  - session energy
  - CP voltage
  - device ID / model / manufacturer / firmware (if present)
- write:
  - start charging
  - stop charging
  - max current
  - direct work mode
  - level detection
  - stop on disconnect
  - LED brightness

### Cloud transport

- login against X-Cheng backend
- auto-select first charger or use configured cloud device ID
- read:
  - state / state code
  - online flag
  - voltage / current / power
  - temperature
  - accumulated energy
  - max current
  - error code
  - today / total energy from charge records
  - cloud-side config values where available
- write:
  - start charging
  - stop charging
  - max current
  - direct work mode
  - level detection
  - generic config changes through `changeCpConfig`

## Important limitations

1. **Not hardware-tested here**

   The adapter code is complete and installable, but I could not talk to your exact charger during creation.  
   The implementation is based on reverse-engineered community protocol work plus current ioBroker adapter conventions.

2. **Local config values are write-only**

   On the local TCP protocol, config items like max current or direct work mode are generally **not returned back by the charger**.  
   Because of that, the adapter mirrors the **last written value** in `charger.control.*` states so your EMS can keep a stable desired setpoint.

3. **Auto mode is startup-biased**

   `auto` tries local first.  
   If local polling fails repeatedly, it can switch to cloud.  
   It does **not** automatically switch back to local until restart.

## Installation

### Recommended

1. Unpack this ZIP.
2. Push the folder to your own Git repository (GitHub / Gitea / GitLab).
3. Install the adapter in ioBroker **from your own URL**.

CLI style:

```bash
iobroker url <your-git-repository-url>
```

Then create an instance and configure transport + credentials / local host.

## Configuration

### Local only

Use this when your charger responds on the LAN:

- `transport = local`
- enter `host` / IP
- optionally enter the 19-digit `localDeviceId`
- leave discovery enabled if you want auto-detection

### Cloud only

Use this when the charger is effectively app-bound:

- `transport = cloud`
- fill in `cloudUsername`
- fill in `cloudPassword`
- optionally set `cloudDeviceId`

### Auto

Best default for mixed / uncertain setups:

- `transport = auto`
- provide local host if known
- keep cloud credentials as fallback

## State layout

### Information

- `info.connection`
- `info.transportConfigured`
- `info.transportActive`
- `info.lastError`
- `info.lastPoll`

### Charger info

- `charger.info.host`
- `charger.info.deviceId`
- `charger.info.name`
- `charger.info.model`
- `charger.info.manufacturer`
- `charger.info.firmware`
- `charger.info.serialNumber`

### Charger status

- `charger.status.online`
- `charger.status.stateCode`
- `charger.status.state`
- `charger.status.isCharging`
- `charger.status.error`
- `charger.status.errorCode`
- `charger.status.voltage`
- `charger.status.voltageL2`
- `charger.status.voltageL3`
- `charger.status.current`
- `charger.status.currentL2`
- `charger.status.currentL3`
- `charger.status.power`
- `charger.status.temperature`
- `charger.status.temperatureInternal`
- `charger.status.cpVoltage`
- `charger.status.sessionEnergy`
- `charger.status.sessionStart`
- `charger.status.sessionDurationMin`
- `charger.status.energyToday`
- `charger.status.energyTotal`
- `charger.status.accEnergy`
- `charger.status.accEnergy2`
- `charger.status.maxCurrentReported`

### Writable control states

- `charger.control.refresh` (button)
- `charger.control.start` (button)
- `charger.control.stop` (button)
- `charger.control.maxCurrent` (number, amps)
- `charger.control.directWorkMode` (boolean)
- `charger.control.levelDetection` (boolean)
- `charger.control.stopOnDisconnect` (boolean)
- `charger.control.ledBrightness` (number; expected local values: `0`, `1`, `3`)

## EMS usage

The intended EMS control loop is simple:

- compute desired charge current in ioBroker
- write the target current to `charger.control.maxCurrent`
- optionally gate charging with `charger.control.start` / `charger.control.stop`
- read actual telemetry from `charger.status.*`

Example:

```javascript
setState('duosidaems.0.charger.control.maxCurrent', 10);
```

Start charging:

```javascript
setState('duosidaems.0.charger.control.start', true);
```

Stop charging:

```javascript
setState('duosidaems.0.charger.control.stop', true);
```

## Development notes

- no external runtime dependencies besides `@iobroker/adapter-core`
- Node.js built-in test runner is used for lightweight protocol tests
- package metadata targets modern ioBroker environments

## Credits

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
