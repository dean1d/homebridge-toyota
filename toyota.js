'use strict';

const { randomUUID } = require('node:crypto');
const { on, once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { Session, request } = require('./auth');

const gateway = 'https://onecdn.telematicsct.com';
const graphHost = 'oa-api.telematicsct.com';
const graph = 'https://' + graphHost + '/graphql';
const appSyncKey = 'da2-zgeayo2qh5eo7cj6pmdwhwugze';
const resolverKey = 'pypIHG015k4ABHWbcI4G0a94F7cC0JDo1OynpAsG';
const opening = '{ position { status } }';
const lockedOpening = '{ lock { status } position { status } }';
const statusQuery = `query GetVehicleStatus($vin: String!) {
  getVehicleStatus(vin: $vin) { vin vehicleState {
    doors { driverSide ${lockedOpening} passengerSide ${lockedOpening}
      rearDriverSide ${lockedOpening} rearPassengerSide ${lockedOpening} }
    windows { driverSide ${opening} passengerSide ${opening} rearDriverSide ${opening} rearPassengerSide ${opening} }
    hatch ${lockedOpening} trunk ${lockedOpening} tailgate ${lockedOpening}
    hood ${opening} moonroof ${opening}
    engine { running status }
  } }
}`;
const subscribeQuery = `subscription ReceiveRemoteCommandStatus($vin: String!) {
  onPostRemoteCallback(vin: $vin) { appRequestNo status vin command commandEnded }
}`;
const commandQuery = `mutation SendRemoteCommand($command: String!, $autoFixCommands: [String]!) {
  executeRemoteCommand(commandInputBody: { command: $command, autofixCommands: $autoFixCommands }) {
    payload { requestNo correlationId returnCode }
    status { messages { responseCode } }
  }
}`;

const doorCaps = ['dlockUnlockCapable', 'doorLockUnlockCapable'];
const hatchCaps = ['trunkLockUnlockCapable', 'powerTailgateCapable'];
// caps: Toyota capability flags. explicit: a flag must be true, as Toyota's app requires.
// confirm: how a status read proves the command worked when Toyota's reply is ambiguous.
const commands = {
  lock: { name: 'door-lock', code: 'DL', value: 1, caps: doorCaps, confirm: (s) => s.locked === true },
  unlock: { name: 'door-unlock', code: 'DL', value: 2, caps: doorCaps, confirm: (s) => s.locked === false },
  start: { name: 'engine-start', code: 'RES', value: 1, caps: ['estartEnabled', 'estartStopCapable', 'remoteEngineStartStop'] },
  stop: { name: 'engine-stop', code: 'RES', value: 2, caps: ['estopEnabled', 'estartStopCapable', 'remoteEngineStartStop'] },
  hazards: { name: 'hazard-on', code: 'HZ', value: 1, caps: ['hazardCapable'] },
  horn: { name: 'sound-horn', caps: ['hornCapable'], explicit: true },
  buzzer: { name: 'buzzer-warning', caps: ['buzzerCapable'], explicit: true },
  hatchLock: { name: 'trunk-lock', caps: hatchCaps, explicit: true, confirm: (s) => s.hatchLocked === true },
  hatchUnlock: { name: 'trunk-unlock', caps: hatchCaps, explicit: true, confirm: (s) => s.hatchLocked === false },
  closeWindows: { name: 'power-window-close', caps: ['powerWindowsCloseCapable'], explicit: true },
};
const confirmWindowMs = 60_000;
const vehicleCacheMs = 10 * 60_000;
const confirmPollMs = 5_000;
const doorLocks = new Set(['driver side door', 'passenger side door', 'driver side rear door', 'passenger side rear door']);
// REST status sections by "category section"; the rear doors are the Sienna's sliding doors.
const restOpenings = {
  'driver side door': 'doors', 'passenger side door': 'doors',
  'driver side rear door': 'slidingDoors', 'passenger side rear door': 'slidingDoors',
  'driver side window': 'windows', 'passenger side window': 'windows',
  'driver side rear window': 'windows', 'passenger side rear window': 'windows',
};
// Toyota's app finds these sections by name in any category.
const restAnyCategory = { hatch: 'hatch', trunk: 'hatch', tailgate: 'hatch', hood: 'hood', bonnet: 'hood', moonroof: 'moonroof' };
const graphDoors = { driverSide: 'doors', passengerSide: 'doors', rearDriverSide: 'slidingDoors', rearPassengerSide: 'slidingDoors' };
const openingNames = ['doors', 'slidingDoors', 'windows', 'hatch', 'hood', 'moonroof'];

function lockValue(value) {
  switch (String(value).toLowerCase()) {
    case 'lock':
    case 'locked': return true;
    case 'unlock':
    case 'unlocked': return false;
    default: return null;
  }
}

function closedValue(value) {
  switch (String(value).toLowerCase()) {
    case 'close':
    case 'closed': return true;
    case 'open':
    case 'opened': return false;
    default: return null;
  }
}

function engineValue(value) {
  const state = String(value).toLowerCase();
  if (['on', 'running', 'started', 'true', '1'].includes(state)) return true;
  return ['off', 'stopped', 'false', '0'].includes(state) ? false : null;
}

// false (unlocked, open) wins, so one open door makes the whole group open.
function combine(values) {
  if (values.includes(false)) return false;
  return values.includes(true) ? true : null;
}

function sectionLock(values) {
  const entries = values.filter((item) => item && lockValue(item.value) !== null);
  const active = entries.filter((item) => item.status === 1);
  const fallback = entries.filter((item) => lockValue(item.value) || !Object.hasOwn(item, 'status'));
  const candidates = new Set((active.length ? active : fallback).map((item) => lockValue(item.value)));
  return candidates.size === 1 ? candidates.values().next().value : null;
}

function sectionClosed(values) {
  const position = values.map((item) => closedValue(item?.value)).find((value) => value !== null);
  if (position !== undefined) return position;
  // Toyota's app shows an opening as closed when it reports only a lock state.
  return values.length && values.every((item) => lockValue(item?.value) !== null) ? true : null;
}

function collect() {
  return { locks: [], hatchLocks: [], ...Object.fromEntries(openingNames.map((name) => [name, []])) };
}

function summarize(found) {
  return {
    locked: combine(found.locks), hatchLocked: combine(found.hatchLocks),
    ...Object.fromEntries(openingNames.map((name) => [name, combine(found[name])])),
  };
}

function restStatus(status) {
  const categories = status?.vehicleStatus ?? status?.status?.vehicleStatus;
  const found = collect();
  const named = new Set();
  for (const category of Array.isArray(categories) ? categories : []) {
    if (!Array.isArray(category?.sections)) continue;
    const categoryName = String(category.category).toLowerCase();
    for (const section of category.sections) {
      if (!Array.isArray(section?.values)) continue;
      const sectionName = String(section.section).toLowerCase();
      const key = `${categoryName} ${sectionName}`;
      if (doorLocks.has(key)) found.locks.push(sectionLock(section.values));
      const anyCategory = restAnyCategory[sectionName];
      if (restOpenings[key]) {
        found[restOpenings[key]].push(sectionClosed(section.values));
      } else if (anyCategory && !named.has(sectionName)) {
        // The app reads the first section with each name, and cargo locks only under Other.
        named.add(sectionName);
        found[anyCategory].push(sectionClosed(section.values));
        if (anyCategory === 'hatch' && categoryName === 'other') found.hatchLocks.push(sectionLock(section.values));
      }
    }
  }
  return summarize(found);
}

function graphStatus(state) {
  const found = collect();
  for (const [door, name] of Object.entries(graphDoors)) {
    found.locks.push(lockValue(state?.doors?.[door]?.lock?.status));
    found[name].push(closedValue(state?.doors?.[door]?.position?.status));
  }
  for (const window of Object.values(state?.windows ?? {})) found.windows.push(closedValue(window?.position?.status));
  for (const cargo of ['hatch', 'trunk', 'tailgate']) {
    found.hatch.push(closedValue(state?.[cargo]?.position?.status));
    found.hatchLocks.push(lockValue(state?.[cargo]?.lock?.status));
  }
  found.hood.push(closedValue(state?.hood?.position?.status));
  found.moonroof.push(closedValue(state?.moonroof?.position?.status));
  return { ...summarize(found), running: engineValue(state?.engine?.running ?? state?.engine?.status) };
}

function checkCommand(vehicle, command) {
  const remote = vehicle.remoteSubscriptionStatus;
  const status = vehicle.subscriptionStatus;
  const active = typeof remote === 'string' && remote
    ? remote.toUpperCase() === 'ACTIVE'
    : typeof status === 'string' && status
      ? ['ACTIVE', 'SUBSCRIBED'].includes(status.toUpperCase())
      : vehicle.remoteSubscriptionExists === true;
  if (!active || [10, 11].includes(Number(vehicle.remoteDisplay))
    || (vehicle.features && vehicle.features.remoteCommands !== 1)) {
    throw new Error('Toyota reports remote commands unavailable for this vehicle.');
  }
  const flags = command.caps.flatMap((key) => [
    vehicle.remoteServiceCapabilities?.[key], vehicle.extendedCapabilities?.[key],
  ]);
  const reported = command.explicit
    ? (flags.includes(true) || undefined)
    : flags.find((value) => typeof value === 'boolean');
  const explicit = command.explicit || ['NG86', 'GR86'].includes(vehicle.generation);
  if (reported === false || (explicit && reported !== true)) {
    throw new Error('Toyota reports this command is unsupported for this vehicle.');
  }
}

function authenticatedHeaders(session, vehicle = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + session.tokens.access_token,
    'X-GUID': session.tokens.guid,
    'X-APPBRAND': 'T',
    'X-APPVERSION': '3.5.0',
    'X-OSNAME': 'Android',
    'X-OSVERSION': '14',
    'X-LOCALE': 'en-US',
    'User-Agent': 'okhttp/5.3.2',
    'X-DEVICE-TIMEZONE': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'X-CORRELATIONID': randomUUID(),
    'X-CHANNEL': 'ONEAPP',
    'X-BRAND': vehicle.brand || 'T',
    'x-region': vehicle.region || 'US',
    Accept: 'application/json',
    ...(vehicle.vin && { VIN: vehicle.vin }),
  };
}

class ToyotaClient {
  constructor(sessionFile, { fetch = globalThis.fetch, WebSocket = globalThis.WebSocket } = {}) {
    this.fetch = fetch;
    this.WebSocket = WebSocket;
    this.session = new Session(sessionFile, fetch);
  }

  async api(url, vehicle, body, graphRequest = false) {
    let session = await this.session.get();
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = authenticatedHeaders(session, vehicle);
      headers['X-API-KEY'] = graphRequest ? appSyncKey : resolverKey;
      if (graphRequest) {
        headers['x-resolver-api-key'] = resolverKey;
        headers['x-deviceid'] = session.device_id;
        if (vehicle?.backdoorType) headers.backdoorType = vehicle.backdoorType;
      } else if (vehicle?.generation) {
        headers['X-GENERATION'] = vehicle.generation;
      }
      const response = await request(this.fetch, url, {
        method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      const errors = Array.isArray(data?.errors) ? data.errors : [];
      const authRejected = response.status === 401 || errors.some((error) => (
        ['APIGW-403', 'APPSYNC-AUTH-403'].includes(error?.errorType ?? error?.extensions?.code)
        || /^unauthorized$|jwt expired/i.test(error?.message ?? '')
      ));
      // An auth rejection means Toyota never ran the request, so one retry is safe for commands too.
      if (authRejected && attempt === 0) {
        session = await this.session.get(session.tokens.access_token);
        continue;
      }
      if (!response.ok || errors.length || !data) {
        throw new Error(`Toyota rejected the request (HTTP ${response.status}).`);
      }
      return graphRequest ? data.data : data.payload ?? data;
    }
  }

  async vehicles() {
    if (this.vehicleCache && performance.now() < this.vehicleCache.until) return this.vehicleCache.list;
    const vehicles = await this.api(gateway + '/oneapi/v2/vehicle/guid');
    if (!Array.isArray(vehicles)) throw new Error('Toyota did not return a vehicle list.');
    this.vehicleCache = { list: vehicles, until: performance.now() + vehicleCacheMs };
    return vehicles;
  }

  // note(message) receives progress for the log: Toyota replies and vehicle confirmation.
  async run(vin, action, note = () => {}) {
    const matches = (await this.vehicles()).filter((vehicle) => vehicle?.vin === vin);
    if (matches.length !== 1) throw new Error('The configured VIN was not found on your Toyota account.');
    const vehicle = { ...matches[0], generation: String(matches[0].generation ?? '').trim().toUpperCase() };
    const appSync = ['24MM', '26BEV'].includes(vehicle.generation);
    const route = ['21MM', 'NG86', 'GR86'].includes(vehicle.generation);
    const legacy = vehicle.generation === '17CY';
    if (!appSync && !route && !legacy && vehicle.generation !== '17CYPLUS') {
      throw new Error('Toyota reported an unsupported telematics generation.');
    }

    if (action === 'status') {
      if (appSync) {
        const data = await this.api(graph, { ...vehicle, backdoorType: vehicle.backdoorType || 'hatch' }, {
          operationName: 'GetVehicleStatus', query: statusQuery, variables: { vin },
        }, true);
        const reported = data?.getVehicleStatus;
        if (reported?.vin && reported.vin !== vin) throw new Error('Toyota returned status for a different vehicle.');
        return graphStatus(reported?.vehicleState);
      }
      const base = route ? '/v1/remote/route/'
        : legacy ? '/oneapi/v1/legacy/remote/' : '/oneapi/v1/global/remote/';
      const [status, engine] = await Promise.all([
        this.api(gateway + (legacy ? '/oneapi/v2/legacy/remote/status' : base + 'status'), vehicle),
        // Engine status is optional; doors and locks still matter when it fails.
        this.api(gateway + base + 'engine-status', vehicle).catch(() => null),
      ]);
      const engineState = typeof engine?.status === 'object' ? engine.status : engine;
      return { ...restStatus(status), running: engineValue(engineState?.status) };
    }

    if (!Object.hasOwn(commands, action)) throw new Error('Unsupported Toyota command.');
    const command = commands[action];
    checkCommand(vehicle, command);
    // Toyota's app sends no hatch lock over AppSync, and legacy vehicles only take coded commands.
    if ((appSync && action === 'hatchLock') || (legacy && !command.code)) {
      throw new Error('Toyota reports this command is unsupported for this vehicle.');
    }
    if (appSync) return this.appSyncCommand(vehicle, command.name, note);

    // Newer commands without a legacy code use the route endpoint on every REST generation.
    const viaRoute = route || !command.code;
    const path = viaRoute ? '/v1/remote/route/command'
      : legacy ? '/oneapi/v1/legacy/remote/command' : '/oneapi/v1/global/remote/command';
    let body = { command: command.name };
    if (viaRoute) body.autoFixPopup = false;
    if (action === 'buzzer') body.beepCount = 10;
    if (legacy) {
      const session = await this.session.get();
      body = {
        vin, guid: session.tokens.guid, deviceId: session.device_id, deviceType: 'Android',
        command: { code: command.code, value: command.value },
      };
    }
    const result = await this.api(gateway + path, vehicle, body);
    const code = String(result.returnCode ?? '');
    const safeCode = /^[\w-]{1,32}$/.test(code) ? ` (${code})` : '';
    if (!code || code === 'ONE-RES-10000') {
      note(`Toyota accepted ${command.name}${safeCode}.`);
      return;
    }
    if (command.confirm) {
      note(`Toyota replied${safeCode} before the vehicle acted; checking status for up to ${confirmWindowMs / 1000}s.`);
      // Toyota often replies before the vehicle acts (~30s), so poll status. Read only;
      // never submit a second command to resolve an ambiguous outcome.
      for (let waited = 0; waited <= confirmWindowMs; waited += confirmPollMs) {
        if (waited) await sleep(confirmPollMs);
        const status = await this.run(vin, 'status').catch(() => null);
        if (status && command.confirm(status)) {
          note(`Vehicle confirmed ${command.name} after ${waited / 1000}s.`);
          return;
        }
      }
    }
    throw new Error(`Toyota did not confirm the remote command${safeCode}.`);
  }

  async appSyncCommand(vehicle, command, note) {
    const { vin } = vehicle;
    const session = await this.session.get();
    const authorization = {
      host: graphHost, 'x-api-key': appSyncKey,
      Authorization: 'Bearer ' + session.tokens.access_token,
      'x-channel': 'ONEAPP', 'X-BRAND': 'T', 'X-APPBRAND': 'T',
      'x-region': vehicle.region || 'US', vin, 'x-guid': session.tokens.guid,
      'x-deviceid': session.device_id,
    };
    const query = new URLSearchParams({
      header: Buffer.from(JSON.stringify(authorization)).toString('base64'),
      payload: 'e30=',
    });
    const socket = new this.WebSocket('wss://' + graphHost + '/graphql/realtime?' + query, 'graphql-ws');
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    socket.addEventListener('error', disconnected, { once: true });
    socket.addEventListener('close', disconnected, { once: true });
    const messages = on(socket, 'message', { signal: abort.signal });
    const id = randomUUID();
    let timer = setTimeout(disconnected, 15_000);
    const send = (message) => socket.send(JSON.stringify(message));
    const waitFor = async (matches) => {
      for (;;) {
        const { value } = await messages.next();
        const message = JSON.parse(value[0].data);
        if (['connection_error', 'error'].includes(message.type)) {
          throw new Error('Toyota rejected the remote command subscription.');
        }
        if (matches(message)) return;
      }
    };
    try {
      await once(socket, 'open', { signal: abort.signal });
      send({ type: 'connection_init' });
      await waitFor(({ type }) => type === 'connection_ack');
      send({
        id, type: 'start',
        payload: {
          data: JSON.stringify({ query: subscribeQuery, variables: { vin } }),
          extensions: { authorization },
        },
      });
      await waitFor((message) => message.type === 'start_ack' && message.id === id);
      clearTimeout(timer);
      timer = setTimeout(disconnected, 80_000);
      const data = await this.api(graph, vehicle, {
        operationName: 'SendRemoteCommand', query: commandQuery,
        variables: { command, autoFixCommands: [] },
      }, true);
      const execution = data?.executeRemoteCommand?.payload;
      if (!execution?.correlationId) throw new Error('Toyota did not accept the remote command.');
      note(`Toyota accepted ${command}; waiting for the vehicle.`);
      await waitFor((message) => {
        if (message.type !== 'data' || message.id !== id) return false;
        const update = message.payload?.data?.onPostRemoteCallback;
        if (update?.vin !== vin || (execution.requestNo != null && update.appRequestNo != null
          && String(execution.requestNo) !== String(update.appRequestNo))) return false;
        if (update.command && update.command !== command && update.appRequestNo == null) return false;
        const state = String(update.status).toLowerCase();
        if (state === 'completed') {
          note(`Vehicle completed ${command}.`);
          return true;
        }
        if (state === 'in_progress' && !update.commandEnded) return false;
        throw new Error('Toyota did not complete the remote command.');
      });
    } catch (error) {
      if (abort.signal.aborted) throw new Error('Toyota did not confirm the command. Check the Toyota app before retrying.');
      if (error instanceof SyntaxError) throw new Error('Toyota returned an invalid command response.');
      throw error;
    } finally {
      clearTimeout(timer);
      await messages.return();
      socket.close();
    }
  }
}

module.exports = { ToyotaClient };

