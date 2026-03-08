# Duosida EMS datapoints

Diese Datei beschreibt **nur die relevanten Read-/Write-Datenpunkte** für die Anbindung an ein EMS oder eine übergeordnete Logik in ioBroker.

## Grundprinzip

- **1 Instanz = 1 Wallbox**
- Das EMS schreibt nur auf `charger.control.*`
- Die Wallbox-Telemetrie wird nur aus `charger.status.*` gelesen
- Bei älteren lokalen Modellen sind einige Konfigurationswerte **write-only**; der Adapter spiegelt in diesen Fällen den **zuletzt geschriebenen Wert** zurück

---

## Minimalprofil für EMS

Wenn ihr die Wallbox im EMS nur sauber freigeben, sperren und in A regeln wollt, reichen praktisch diese Datenpunkte:

### Read

- `info.connection`
- `charger.status.online`
- `charger.status.state`
- `charger.status.stateCode`
- `charger.status.isCharging`
- `charger.status.error`
- `charger.status.errorCode`
- `charger.status.power`
- `charger.status.current`
- `charger.status.voltage`
- `charger.status.maxCurrentReported`

### Write

- `charger.control.start`
- `charger.control.stop`
- `charger.control.maxCurrent`
- `charger.control.refresh`

---

## Vollständige Datenpunktliste

## Read-Datenpunkte

| Datenpunkt | Typ | Bedeutung | Verfügbarkeit |
|---|---:|---|---|
| `info.connection` | boolean | Adapter hat Verbindung zur Wallbox oder Cloud | lokal + cloud |
| `info.transportConfigured` | string | konfigurierte Betriebsart (`auto`, `local`, `cloud`) | lokal + cloud |
| `info.transportActive` | string | aktuell aktiver Transport | lokal + cloud |
| `info.lastError` | string | letzter Fehlertext | lokal + cloud |
| `info.lastPoll` | number/date | Zeitstempel des letzten erfolgreichen Polls | lokal + cloud |
| `charger.info.host` | string | Ziel-IP oder Cloud-Endpoint | lokal + cloud |
| `charger.info.deviceId` | string | Geräte-ID | lokal + cloud |
| `charger.info.name` | string | Name der Wallbox | meist cloud |
| `charger.info.model` | string | Modellkennung | lokal + cloud |
| `charger.info.manufacturer` | string | Hersteller | lokal + cloud |
| `charger.info.firmware` | string | Firmware | lokal + cloud |
| `charger.info.serialNumber` | string | Seriennummer | meist cloud |
| `charger.status.online` | boolean | Wallbox online/reachable | lokal + cloud |
| `charger.status.stateCode` | number | numerischer Statuscode | lokal + cloud |
| `charger.status.state` | string | Status als Text | lokal + cloud |
| `charger.status.isCharging` | boolean | aktiver Ladevorgang | lokal + cloud |
| `charger.status.error` | boolean | Fehler vorhanden | lokal + cloud |
| `charger.status.errorCode` | number | Fehlercode | meist cloud |
| `charger.status.voltage` | number | Spannung L1 in V | lokal + cloud |
| `charger.status.voltageL2` | number | Spannung L2 in V | meist cloud / 3-phasig |
| `charger.status.voltageL3` | number | Spannung L3 in V | meist cloud / 3-phasig |
| `charger.status.current` | number | Strom L1 in A | lokal + cloud |
| `charger.status.currentL2` | number | Strom L2 in A | meist cloud / 3-phasig |
| `charger.status.currentL3` | number | Strom L3 in A | meist cloud / 3-phasig |
| `charger.status.power` | number | Ladeleistung in W | lokal + cloud |
| `charger.status.temperature` | number | Stationstemperatur in °C | lokal + cloud |
| `charger.status.temperatureInternal` | number | interne Temperatur in °C | eher lokal |
| `charger.status.cpVoltage` | number | CP-Spannung | eher lokal |
| `charger.status.sessionEnergy` | number | Energie der aktuellen Session in kWh | eher lokal |
| `charger.status.sessionStart` | number/date | Startzeit der Session | eher lokal |
| `charger.status.sessionDurationMin` | number | Sitzungsdauer in Minuten | eher lokal |
| `charger.status.energyToday` | number | heutige Energie in kWh | meist cloud |
| `charger.status.energyTotal` | number | Gesamtenergie in kWh | meist cloud |
| `charger.status.accEnergy` | number | akkumulierte Energie | meist cloud |
| `charger.status.accEnergy2` | number | zweiter Energiewert laut Backend | meist cloud |
| `charger.status.maxCurrentReported` | number | von der Box gemeldeter Maximalstrom in A | meist cloud |

## Write-Datenpunkte

| Datenpunkt | Typ | Bedeutung | Wertebereich |
|---|---:|---|---|
| `charger.control.refresh` | button/boolean | sofortiges Neulesen auslösen | `true` triggern |
| `charger.control.start` | button/boolean | Ladung starten | `true` triggern |
| `charger.control.stop` | button/boolean | Ladung stoppen | `true` triggern |
| `charger.control.maxCurrent` | number | Soll-Maximalstrom | Integer `6..32` A |
| `charger.control.directWorkMode` | boolean | Plug-and-charge / Direktmodus | `true/false` |
| `charger.control.levelDetection` | boolean | CP -12V / Level-Detection | `true/false` |
| `charger.control.stopOnDisconnect` | boolean | Stop bei Fahrzeugtrennung | `true/false` |
| `charger.control.ledBrightness` | number | LED-Helligkeit | `0`, `1`, `3` |

---

## Semantik der Write-Punkte

### Button-States

Diese States werden **mit `true` geschrieben** und danach vom Adapter automatisch wieder quittiert/zurückgesetzt:

- `charger.control.refresh`
- `charger.control.start`
- `charger.control.stop`

Beispiel:

```javascript
setState('duosidaems.0.charger.control.start', true);
```

### Sollstrom

`charger.control.maxCurrent` ist der wichtigste EMS-State.

Beispiel:

```javascript
setState('duosidaems.0.charger.control.maxCurrent', 10);
```

Hinweise:

- Ganzzahl in Ampere
- gültig: `6` bis `32`
- bei lokalem Protokoll wird der zuletzt gesetzte Wert ggf. **gespiegelt**, auch wenn die Wallbox ihn nicht aktiv zurückmeldet

### Erweiterte Schaltpunkte

Diese sind sinnvoll, aber nicht zwingend für die EMS-Regelung:

- `charger.control.directWorkMode`
- `charger.control.levelDetection`
- `charger.control.stopOnDisconnect`
- `charger.control.ledBrightness`

---

## Empfehlung für euer EMS

Für eine robuste PV-/EMS-Regelung empfehle ich genau diese Kernpunkte zu verwenden:

### Lesen

- `charger.status.online`
- `charger.status.state`
- `charger.status.isCharging`
- `charger.status.power`
- `charger.status.current`
- `charger.status.voltage`
- `charger.status.error`
- `charger.status.maxCurrentReported`

### Schreiben

- `charger.control.maxCurrent`
- `charger.control.start`
- `charger.control.stop`

---

## Wichtige Einschränkung bei alten lokalen Geräten

Bei älteren lokalen SmartCharge-Geräten sind mehrere Konfigurationswerte protocol-seitig **write-only**. Das betrifft typischerweise:

- `charger.control.maxCurrent`
- `charger.control.directWorkMode`
- `charger.control.levelDetection`
- `charger.control.stopOnDisconnect`
- `charger.control.ledBrightness`

Der Adapter hält deshalb intern einen **Shadow-/Mirror-Wert**, damit das EMS weiterhin einen stabilen Zielwert lesen kann.
