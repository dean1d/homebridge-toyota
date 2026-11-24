'use strict';

const { mkdir } = require('node:fs/promises');
const { dirname } = require('node:path');
const { login, saveSession } = require('../auth');
const { sessionPath } = require('../settings');
const { ToyotaClient } = require('../toyota');

(async () => {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

  class ToyotaUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      const path = sessionPath(this.homebridgeStoragePath);
      let active;
      const route = (name, handler) => this.onRequest(name, async (body) => {
        try {
          return await handler(body);
        } catch (error) {
          throw new RequestError(error.constructor === Error ? error.message : 'Toyota setup failed.', {});
        }
      });

      route('/login', async ({ username, password }) => {
        if (active) throw new Error('A Toyota sign-in is already in progress.');
        if (typeof username !== 'string' || !username.trim() || typeof password !== 'string') {
          throw new Error('Enter your Toyota account email.');
        }
        const attempt = {};
        active = attempt;
        let otpRequired;
        const challenge = new Promise((resolve) => { otpRequired = resolve; });
        attempt.result = login(globalThis.fetch, {
          username: username.trim(),
          password,
          askCode: () => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              attempt.submit = undefined;
              reject(new Error('Verification expired. Sign in again.'));
            }, 5 * 60_000);
            attempt.submit = (code) => {
              clearTimeout(timeout);
              attempt.submit = undefined;
              resolve(code);
            };
            otpRequired({ needsCode: true });
          }),
        }).then(async (session) => {
          const client = new ToyotaClient(path);
          // Discover against the new login before replacing any existing session.
          client.session.cached = session;
          const vehicles = (await client.vehicles()).filter(({ vin }) => /^[A-HJ-NPR-Z0-9]{17}$/.test(vin))
            .map(({ vin, modelName, modelYear }) => ({ vin, modelName, modelYear }));
          if (!vehicles.length) throw new Error('Toyota did not return any vehicles for this account.');
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await saveSession(path, await client.session.get());
          return { vehicles };
        }).finally(() => { active = undefined; });
        return Promise.race([attempt.result, challenge]);
      });

      route('/verify', ({ code }) => {
        if (typeof code !== 'string' || !code.trim()) throw new Error('Enter the Toyota verification code.');
        if (!active?.submit) throw new Error('Verification expired. Sign in again.');
        const { submit, result } = active;
        submit(code.trim());
        return result;
      });
      this.ready();
    }
  }
  new ToyotaUiServer();
})().catch(() => {
  console.error('The Toyota settings server could not start.');
  process.exitCode = 1;
});
