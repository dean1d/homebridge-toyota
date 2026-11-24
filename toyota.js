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
const statusQuery = `query GetVehicleStatus($vin: String!) {
  getVehicleStatus(vin: $vin) { vin vehicleState { doors {
    driverSide { lock { status } }
    passengerSide { lock { status } }
    rearDriverSide { lock { status } }
    rearPassengerSide { lock { status } }
  } } }
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

const commands = {
  lock: { name: 'door-lock', code: 'DL', value: 1 },
  unlock: { name: 'door-unlock', code: 'DL', value: 2 },
  start: { name: 'engine-start', code: 'RES', value: 1 },
  stop: { name: 'engine-stop', code: 'RES', value: 2 },
};
const confirmWindowMs = 60_000;
const vehicleCacheMs = 10 * 60_000;
const confirmPollMs = 5_000;
const doors = new Set(['driver side door', 'passenger side door', 'driver side rear door', 'passenger side rear door']);
const graphDoors = ['driverSide', 'passengerSide', 'rearDriverSide', 'rearPassengerSide'];

function lockValue(value) {
  switch (String(value).toLowerCase()) {
    case 'lock':
    case 'locked': return true;
    case 'unlock':
    case 'unlocked': return false;
    default: return null;
  }
}

function combineLocks(values) {
  if (values.includes(false)) return false;
  return values.includes(true) ? true : null;
}

function restDoorLocks(status) {
  const categories = status?.vehicleStatus ?? status?.status?.vehicleStatus;
  if (!Array.isArray(categories)) return null;
  const locks = [];
  for (const category of categories) {
    if (!Array.isArray(category?.sections)) continue;
    for (const section of category.sections) {
      if (!doors.has(`${category.category} ${section?.section}`.toLowerCase())
        || !Array.isArray(section?.values)) continue;
      const entries = section.values.filter((item) => item && lockValue(item.value) !== null);
      const active = entries.filter((item) => item.status === 1);
      const fallback = entries.filter((item) => lockValue(item.value) || !Object.hasOwn(item, 'status'));
      const candidates = new Set((active.length ? active : fallback).map((item) => lockValue(item.value)));
      if (candidates.size === 1) locks.push(candidates.values().next().value);
    }
  }
  return combineLocks(locks);
}

function checkCommand(vehicle, action) {
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
  const keys = ['start', 'stop'].includes(action)
    ? ['estartEnabled', 'estartStopCapable', 'remoteEngineStartStop']
    : ['dlockUnlockCapable', 'doorLockUnlockCapable'];
  const reported = keys.flatMap((key) => [
    vehicle.remoteServiceCapabilities?.[key], vehicle.extendedCapabilities?.[key],
  ]).find((value) => typeof value === 'boolean');
  if (reported === false || (['NG86', 'GR86'].includes(vehicle.generation) && reported !== true)) {
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

  async run(vin, action) {
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
        const states = reported?.vehicleState?.doors;
        return { locked: combineLocks(graphDoors.map((door) => lockValue(states?.[door]?.lock?.status))) };
      }
      const path = route ? '/v1/remote/route/status'
        : legacy ? '/oneapi/v2/legacy/remote/status' : '/oneapi/v1/global/remote/status';
      return { locked: restDoorLocks(await this.api(gateway + path, vehicle)) };
    }

    if (!Object.hasOwn(commands, action)) throw new Error('Unsupported Toyota command.');
    checkCommand(vehicle, action);
    const command = commands[action];
    if (appSync) return this.appSyncCommand(vehicle, command.name);

    const path = route ? '/v1/remote/route/command'
      : legacy ? '/oneapi/v1/legacy/remote/command' : '/oneapi/v1/global/remote/command';
    let body = { command: command.name };
    if (route) body.autoFixPopup = false;
    if (legacy) {
      const session = await this.session.get();
      body = {
        vin, guid: session.tokens.guid, deviceId: session.device_id, deviceType: 'Android',
        command: { code: command.code, value: command.value },
      };
    }
    const result = await this.api(gateway + path, vehicle, body);
    if (result.returnCode && result.returnCode !== 'ONE-RES-10000') {
      const code = String(result.returnCode);
      const safeCode = /^[\w-]{1,32}$/.test(code) ? ` (${code})` : '';
      if (['lock', 'unlock'].includes(action)) {
        // Toyota often replies before the vehicle acts (~30s), so poll status. Read only;
        // never submit a second command to resolve an ambiguous outcome.
        for (let waited = 0; waited <= confirmWindowMs; waited += confirmPollMs) {
          if (waited) await sleep(confirmPollMs);
          const status = await this.run(vin, 'status').catch(() => null);
          if (status?.locked === (action === 'lock')) return;
        }
      }
      throw new Error(`Toyota did not confirm the remote command${safeCode}.`);
    }
  }

  async appSyncCommand(vehicle, command) {
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
      await waitFor((message) => {
        if (message.type !== 'data' || message.id !== id) return false;
        const update = message.payload?.data?.onPostRemoteCallback;
        if (update?.vin !== vin || (execution.requestNo != null && update.appRequestNo != null
          && String(execution.requestNo) !== String(update.appRequestNo))) return false;
        if (update.command && update.command !== command && update.appRequestNo == null) return false;
        const state = String(update.status).toLowerCase();
        if (state === 'completed') return true;
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

