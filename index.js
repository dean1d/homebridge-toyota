'use strict';

const { isAbsolute } = require('node:path');
const { ToyotaClient } = require('./toyota');

module.exports = (api) => api.registerAccessory('homebridge-toyota', 'Toyota', Toyota);

class Toyota {
  constructor(log, config, api) {
    const { Service, Characteristic: C, HapStatusError, HAPStatus } = api.hap;
    const { name, vin, sessionFile } = config;
    const valid = /^[A-HJ-NPR-Z0-9]{17}$/.test(vin)
      && typeof sessionFile === 'string' && isAbsolute(sessionFile);
    const client = valid ? new ToyotaClient(sessionFile) : undefined;

    const call = async (action) => {
      if (!valid) {
        log.error('Configure a valid VIN and an absolute Toyota session file path.');
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      if (this.busy) throw new HapStatusError(HAPStatus.RESOURCE_BUSY);
      this.busy = true;
      try {
        return await client.run(vin, action);
      } catch (error) {
        const detail = error.constructor === Error ? error.message : 'Unexpected connection or response error.';
        log.error(`Toyota ${action} failed. ${detail}`);
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      } finally {
        this.busy = false;
      }
    };

    const info = new Service.AccessoryInformation()
      .setCharacteristic(C.Manufacturer, 'Toyota')
      .setCharacteristic(C.Model, 'Sienna')
      .setCharacteristic(C.SerialNumber, valid ? vin.slice(-8) : 'Toyota');

    const lock = new Service.LockMechanism(`${name} Doors`, 'doors');
    let statusRequest;
    const readLock = () => {
      statusRequest ??= call('status').then(({ locked }) => locked).finally(() => {
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
        const locked = await readLock();
        if (locked === null) throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        return locked ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED;
      })
      .onSet(async (value) => {
        const secured = value === C.LockTargetState.SECURED;
        if (!secured && value !== C.LockTargetState.UNSECURED) {
          throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        await call(secured ? 'lock' : 'unlock');
      });

    const start = new Service.Switch(`${name} Remote Start`, 'remote-start');
    start.getCharacteristic(C.On).onGet(() => false).onSet(async (on) => {
      if (!on) return;
      try {
        await call('start');
      } finally {
        const reset = setTimeout(() => start.updateCharacteristic(C.On, false), 200);
        reset.unref();
      }
    });

    this.services = [info, lock, start];
  }

  getServices() {
    return this.services;
  }
}
