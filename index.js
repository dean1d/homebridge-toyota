'use strict';

const { isAbsolute } = require('node:path');
const { ToyotaClient } = require('./toyota');
const { sessionPath } = require('./settings');

const lockRepeatWindowMs = 30_000;
const statusCacheMs = 30_000;

module.exports = (api) => api.registerAccessory('homebridge-toyota', 'Toyota', Toyota);

class Toyota {
  constructor(log, config, api) {
    const { Service, Characteristic: C, HapStatusError, HAPStatus } = api.hap;
    const { name, vin } = config;
    const sessionFile = config.sessionFile ?? sessionPath(api.user.storagePath());
    const valid = /^[A-HJ-NPR-Z0-9]{17}$/.test(vin)
      && typeof sessionFile === 'string' && isAbsolute(sessionFile);
    const client = valid ? new ToyotaClient(sessionFile) : undefined;

    const call = async (action) => {
      if (!valid) {
        log.error('Configure a valid VIN and an absolute Toyota session file path.');
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      // Status reads are read-only, so only commands take the busy flag.
      const command = action !== 'status';
      if (command && this.busy) throw new HapStatusError(HAPStatus.RESOURCE_BUSY);
      if (command) this.busy = true;
      try {
        return await client.run(vin, action);
      } catch (error) {
        const detail = error.constructor === Error ? error.message : 'Unexpected connection or response error.';
        log.error(`Toyota ${action} failed. ${detail}`);
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      } finally {
        if (command) this.busy = false;
      }
    };

    const info = new Service.AccessoryInformation()
      .setCharacteristic(C.Manufacturer, 'Toyota')
      .setCharacteristic(C.Model, 'Toyota')
      .setCharacteristic(C.SerialNumber, valid ? vin.slice(-8) : 'Toyota');

    const lock = new Service.LockMechanism(`${name} Doors`, 'doors');
    let lastLockWrite;
    let statusRequest;
    let lastStatus;
    const readLock = async () => {
      if (lastStatus && performance.now() < lastStatus.until) return lastStatus.locked;
      statusRequest ??= call('status').then(({ locked }) => {
        lastStatus = { locked, until: performance.now() + statusCacheMs };
        return locked;
      }).finally(() => {
        statusRequest = undefined;
      });
      return statusRequest;
    };
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
      const service = new Service.Switch(`${name} ${label}`, subtype);
      service.getCharacteristic(C.On).onGet(() => false).onSet(async (on) => {
        if (!on) return;
        try {
          await call(action);
        } finally {
          const reset = setTimeout(() => service.updateCharacteristic(C.On, false), 200);
          reset.unref();
        }
      });
      return service;
    };
    const start = momentary('Remote Start', 'remote-start', 'start');
    const stop = momentary('Remote Stop', 'remote-stop', 'stop');

    if (valid) {
      client.vehicles().then((vehicles) => {
        const model = vehicles.find((vehicle) => vehicle?.vin === vin)?.modelName;
        if (typeof model === 'string' && model.trim()) info.updateCharacteristic(C.Model, model.trim());
      }).catch(() => {});
    }

    this.services = [info];
    if (config.showDoorLock !== false) this.services.push(lock);
    if (config.showRemoteStart !== false) this.services.push(start, stop);
  }

  getServices() {
    return this.services;
  }
}
