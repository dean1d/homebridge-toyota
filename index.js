'use strict';

const { isAbsolute } = require('node:path');
const { ToyotaClient } = require('./toyota');
const { sessionPath } = require('./settings');

const lockRepeatWindowMs = 30_000;
const statusCacheMs = 30_000;
const engineHoldMs = 60_000;
// Status fields as [label, true text, false text] for change logging.
const statusLabels = {
  locked: ['Doors', 'locked', 'unlocked'], hatchLocked: ['Hatch lock', 'locked', 'unlocked'],
  doors: ['Front doors', 'closed', 'open'], slidingDoors: ['Sliding doors', 'closed', 'open'],
  windows: ['Windows', 'closed', 'open'], hatch: ['Hatch', 'closed', 'open'],
  hood: ['Hood', 'closed', 'open'], moonroof: ['Moonroof', 'closed', 'open'],
  running: ['Engine', 'running', 'off'],
};
// Cars on one Toyota account share a session file, so they share one client and its token refreshes.
const clients = new Map();

function describe(key, value) {
  if (typeof value !== 'boolean') return 'unknown';
  return value ? statusLabels[key][1] : statusLabels[key][2];
}

// Homebridge log methods read this.prefix, so a copy with its own prefix logs as Toyota-<name>.
function prefixed(log, prefix) {
  return typeof log?.log === 'function' ? Object.assign(Object.create(log), { prefix }) : log;
}

module.exports = (api) => api.registerAccessory('homebridge-toyota', 'Toyota', Toyota);

class Toyota {
  constructor(homebridgeLog, config, api) {
    const { Service, Characteristic: C, HapStatusError, HAPStatus } = api.hap;
    const { name, vin } = config;
    const log = prefixed(homebridgeLog, `Toyota-${name}`);
    const sessionFile = config.sessionFile ?? sessionPath(api.user.storagePath());
    const valid = /^[A-HJ-NPR-Z0-9]{17}$/.test(vin)
      && typeof sessionFile === 'string' && isAbsolute(sessionFile);
    if (valid && !clients.has(sessionFile)) clients.set(sessionFile, new ToyotaClient(sessionFile));
    const client = valid ? clients.get(sessionFile) : undefined;

    const call = async (action) => {
      if (!valid) {
        log.error('Configure a valid VIN and an absolute Toyota session file path.');
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      // Status reads are read-only, so only commands take the busy flag.
      const command = action !== 'status';
      if (command && this.busy) throw new HapStatusError(HAPStatus.RESOURCE_BUSY);
      if (command) this.busy = true;
      if (command) log.info(`Sending ${action} to Toyota.`);
      try {
        return await client.run(vin, action, (message) => log.info(message));
      } catch (error) {
        const detail = error.constructor === Error ? error.message : 'Unexpected connection or response error.';
        log.error(`${action} failed. ${detail}`);
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      } finally {
        if (command) this.busy = false;
      }
    };

    const info = new Service.AccessoryInformation()
      .setCharacteristic(C.Manufacturer, 'Toyota')
      .setCharacteristic(C.Model, 'Toyota')
      .setCharacteristic(C.SerialNumber, valid ? vin.slice(-8) : 'Toyota');

    // Home shows a service by its ConfiguredName; without one every tile takes the car name.
    const named = (Type, label, subtype) => {
      const service = new Type(`${name} ${label}`, subtype);
      service.addOptionalCharacteristic(C.ConfiguredName);
      service.setCharacteristic(C.ConfiguredName, `${name} ${label}`);
      return service;
    };

    const lock = named(Service.LockMechanism, 'Doors', 'doors');
    let lastLockWrite;
    let statusRequest;
    let lastStatus;
    let previousStatus;
    const readStatus = async () => {
      if (lastStatus && performance.now() < lastStatus.until) return lastStatus.status;
      statusRequest ??= call('status').then((status) => {
        lastStatus = { status, until: performance.now() + statusCacheMs };
        const changes = Object.keys(statusLabels)
          .filter((key) => !previousStatus || previousStatus[key] !== status[key])
          .map((key) => (previousStatus
            ? `${statusLabels[key][0]} ${describe(key, previousStatus[key])} -> ${describe(key, status[key])}`
            : `${statusLabels[key][0]} ${describe(key, status[key])}`));
        if (changes.length) log.info(`${previousStatus ? 'Status changed' : 'Status'}: ${changes.join(', ')}.`);
        previousStatus = status;
        return status;
      }).finally(() => {
        statusRequest = undefined;
      });
      return statusRequest;
    };
    const readLock = async () => (await readStatus()).locked;
    // A command sent from Home changes the vehicle; read fresh status afterwards.
    const send = (action) => call(action).finally(() => { lastStatus = undefined; });
    lock.getCharacteristic(C.LockCurrentState).onGet(async () => {
      const locked = await readLock();
      if (locked === null) return C.LockCurrentState.UNKNOWN;
      return locked ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED;
    });
    lock.getCharacteristic(C.LockTargetState)
      .onGet(async () => {
        if (lastLockWrite?.accepted && performance.now() < lastLockWrite.repeatUntil) {
          return lastLockWrite.target;
        }
        const locked = await readLock();
        if (locked === null) throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        return locked ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED;
      })
      .onSet(async (value) => {
        const secured = value === C.LockTargetState.SECURED;
        if (!secured && value !== C.LockTargetState.UNSECURED) {
          throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        if (lastLockWrite?.target === value && performance.now() < lastLockWrite.repeatUntil) {
          return lastLockWrite.result;
        }
        if (lastLockWrite?.pending) throw new HapStatusError(HAPStatus.RESOURCE_BUSY);
        if (statusRequest) await statusRequest.catch(() => {});
        // Another HomeKit write may have arrived while the status read was pending.
        if (lastLockWrite?.target === value && performance.now() < lastLockWrite.repeatUntil) {
          return lastLockWrite.result;
        }
        if (this.busy) throw new HapStatusError(HAPStatus.RESOURCE_BUSY);
        const write = { target: value, pending: true, repeatUntil: Infinity };
        lastLockWrite = write;
        write.result = call(secured ? 'lock' : 'unlock').then(() => {
          write.accepted = true;
        }).finally(() => {
          lastStatus = undefined;
          write.pending = false;
          write.repeatUntil = performance.now() + lockRepeatWindowMs;
        });
        return write.result;
      });

    const momentary = (label, subtype, action) => {
      const service = named(Service.Switch, label, subtype);
      service.getCharacteristic(C.On).onGet(() => false).onSet(async (on) => {
        if (!on) return;
        try {
          await send(action);
        } finally {
          const reset = setTimeout(() => service.updateCharacteristic(C.On, false), 200);
          reset.unref();
        }
      });
      return service;
    };

    // On starts the engine and off stops it. Toyota's engine status lags, so the
    // requested state is shown for a minute after each command.
    const start = named(Service.Switch, 'Remote Start', 'remote-start');
    let engineHold;
    start.getCharacteristic(C.On)
      .onGet(async () => {
        if (engineHold && performance.now() < engineHold.until) return engineHold.on;
        return (await readStatus()).running === true;
      })
      .onSet(async (on) => {
        await send(on ? 'start' : 'stop');
        engineHold = { on: Boolean(on), until: performance.now() + engineHoldMs };
      });

    const hatch = named(Service.LockMechanism, 'Hatch', 'hatch');
    let hatchHold;
    const hatchState = async (states) => {
      if (hatchHold && performance.now() < hatchHold.until) return hatchHold.secured ? states.SECURED : states.UNSECURED;
      const locked = (await readStatus()).hatchLocked;
      if (locked === null) return states.UNKNOWN ?? states.SECURED;
      return locked ? states.SECURED : states.UNSECURED;
    };
    hatch.getCharacteristic(C.LockCurrentState).onGet(() => hatchState(C.LockCurrentState));
    hatch.getCharacteristic(C.LockTargetState)
      .onGet(() => hatchState(C.LockTargetState))
      .onSet(async (value) => {
        const secured = value === C.LockTargetState.SECURED;
        if (!secured && value !== C.LockTargetState.UNSECURED) {
          throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        await send(secured ? 'hatchLock' : 'hatchUnlock');
        hatchHold = { secured, until: performance.now() + engineHoldMs };
        hatch.updateCharacteristic(C.LockCurrentState, secured ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED);
      });

    // Contact sensors read "closed" unless Toyota reports the opening open, as Toyota's app does.
    const openings = [
      ['doors', 'Front Doors'], ['slidingDoors', 'Sliding Doors'], ['windows', 'Windows'],
      ['hatch', 'Hatch Open'], ['hood', 'Hood'], ['moonroof', 'Moonroof'],
    ].map(([key, label]) => {
      const sensor = named(Service.ContactSensor, label, `opening-${key}`);
      sensor.getCharacteristic(C.ContactSensorState).onGet(async () => (
        (await readStatus())[key] === false
          ? C.ContactSensorState.CONTACT_NOT_DETECTED
          : C.ContactSensorState.CONTACT_DETECTED
      ));
      return sensor;
    });

    if (valid) {
      client.vehicles().then((vehicles) => {
        const model = vehicles.find((vehicle) => vehicle?.vin === vin)?.modelName;
        if (typeof model === 'string' && model.trim()) info.updateCharacteristic(C.Model, model.trim());
      }).catch(() => {});
    }

    this.services = [info];
    if (config.showDoorLock !== false) this.services.push(lock);
    if (config.showRemoteStart !== false) this.services.push(start);
    if (config.showOpenings !== false) this.services.push(...openings);
    if (config.showHatch === true) this.services.push(hatch);
    if (config.showHazards === true) this.services.push(momentary('Flash Hazards', 'hazards', 'hazards'));
    if (config.showHorn === true) this.services.push(momentary('Sound Horn', 'horn', 'horn'));
    if (config.showBuzzer === true) this.services.push(momentary('Find Vehicle', 'buzzer', 'buzzer'));
    if (config.showCloseWindows === true) this.services.push(momentary('Close Windows', 'close-windows', 'closeWindows'));
  }

  getServices() {
    return this.services;
  }
}
