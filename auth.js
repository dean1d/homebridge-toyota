'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { readFile, rename, unlink, writeFile } = require('node:fs/promises');

const origin = 'https://login.toyotadriverslogin.com';
const realm = '/realms/root/realms/tmna-native';
const oauth = origin + '/oauth2' + realm;
const clientId = 'oneappsdkclient';
const redirectUri = 'com.toyota.oneapp:/oauth2Callback';

async function request(fetch, url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(20_000), ...options, redirect: 'manual' });
}

async function exchange(fetch, params, previous = {}) {
  const response = await request(fetch, oauth + '/access_token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, ...params }),
  });
  if (!response.ok) throw new Error('Toyota rejected the session. Run the login command if it has expired.');
  const result = await response.json();
  const access = result.access_token;
  const refresh = result.refresh_token ?? previous.refresh_token;
  const id = result.id_token ?? previous.id_token;
  const lifetime = Number(result.expires_in);
  if (![access, refresh, id].every((value) => typeof value === 'string' && value)
    || !Number.isFinite(lifetime) || lifetime <= 0) {
    throw new Error('Toyota returned incomplete OAuth tokens.');
  }
  // Read the account identifier from the token returned by Toyota over TLS.
  const { sub: guid } = JSON.parse(Buffer.from(id.split('.')[1] ?? '', 'base64url'));
  if (!guid) throw new Error('Toyota did not return an account identifier.');
  const now = Date.now() / 1_000;
  return {
    access_token: access, refresh_token: refresh, id_token: id, guid,
    updated_at: now, expires_at: now + lifetime, clock: 'unix',
  };
}

async function login(fetch, { username, password, askCode }) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept-API-Version': 'resource=2.1, protocol=1.0',
    'Accept-Language': 'en-US',
  };
  let challenge = {};
  let passwordSent = false;
  let otpSent = false;
  for (let step = 0; step < 15 && !challenge.tokenId; step++) {
    for (const callback of challenge.callbacks ?? []) {
      const output = Object.fromEntries(callback.output.map(({ name, value }) => [name, value]));
      const prompt = String(output.prompt ?? '').trim().toLowerCase();
      const input = callback.input?.[0];
      switch (callback.type) {
        case 'NameCallback':
          if (['ui_locales', 'ui locale'].includes(prompt)) input.value = 'en-US';
          else if (!['deviceprint', 'mail'].includes(prompt)) input.value = username;
          break;
        case 'PasswordCallback':
          if (prompt === 'one time password') {
            if (otpSent) throw new Error('Toyota did not accept the verification code.');
            input.value = await askCode();
            if (!input.value) throw new Error('Enter the verification code sent by Toyota.');
            otpSent = true;
          } else {
            if (passwordSent) throw new Error('Toyota did not accept the password.');
            input.value = password;
            passwordSent = true;
          }
          break;
        case 'ChoiceCallback': {
          const choices = (output.choices ?? []).map((choice) => String(choice).trim().toLowerCase());
          const local = choices.indexOf('local');
          const alternative = choices.findIndex((choice) => !['google', 'apple', 'facebook'].includes(choice));
          const selected = local < 0 ? alternative : local;
          if (selected < 0) throw new Error('Toyota did not offer a direct account sign-in method.');
          input.value = selected;
          break;
        }
        case 'ConfirmationCallback':
          input.value = 0;
          break;
        case 'HiddenValueCallback':
          break;
        case 'TextOutputCallback':
          if (String(output.messageType) === '2' || String(output.message).toLowerCase() === 'invalid otp') {
            throw new Error('Toyota rejected the login challenge.');
          }
          break;
        default:
          throw new Error('Toyota returned an unsupported sign-in challenge.');
      }
    }
    const response = await request(fetch, origin + '/json' + realm + '/authenticate', {
      method: 'POST', headers, body: JSON.stringify(challenge),
    });
    if (!response.ok) throw new Error('Toyota sign-in failed.');
    challenge = await response.json();
    if (!challenge.tokenId && !challenge.callbacks?.some(({ input }) => input?.length)) {
      throw new Error('Toyota returned no actionable sign-in challenge.');
    }
  }
  if (!challenge.tokenId) throw new Error('Toyota sign-in did not finish.');
  const verifier = randomBytes(64).toString('base64url');
  const query = new URLSearchParams({
    client_id: clientId, scope: 'openid profile write', response_type: 'code',
    redirect_uri: redirectUri, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  const response = await request(fetch, oauth + '/authorize?' + query, {
    headers: { ...headers, Cookie: 'iPlanetDirectoryPro=' + challenge.tokenId },
  });
  const location = response.headers.get('location');
  if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
    throw new Error('Toyota did not return an OAuth redirect.');
  }
  const redirect = new URL(location);
  const codes = redirect.searchParams.getAll('code');
  if (location.split('?')[0] !== redirectUri || redirect.hash
    || redirect.searchParams.has('error') || codes.length !== 1 || !codes[0]) {
    throw new Error('Toyota returned an invalid OAuth redirect.');
  }
  const tokens = await exchange(fetch, {
    grant_type: 'authorization_code', code: codes[0], code_verifier: verifier, redirect_uri: redirectUri,
  });
  return { tokens, device_id: randomBytes(32).toString('hex') };
}

async function saveSession(path, session) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

class Session {
  constructor(path, fetch) {
    this.path = path;
    this.fetch = fetch;
  }

  async get(rejectedToken) {
    if (!this.pending) {
      this.pending = this.read(rejectedToken).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  async read(rejectedToken) {
    let session;
    try {
      session = this.cached ?? JSON.parse(await readFile(this.path, 'utf8'));
      if (!session.tokens?.refresh_token || !session.device_id) throw new Error();
    } catch {
      throw new Error('Toyota session is missing or invalid. Run the login command.');
    }
    const { tokens } = session;
    const margin = Math.min(60, (tokens.expires_at - tokens.updated_at) / 10);
    if (tokens.clock !== 'unix' || !tokens.access_token || !tokens.guid
      || !(tokens.expires_at - margin > Date.now() / 1_000)
      || tokens.access_token === rejectedToken) {
      session = {
        ...session,
        tokens: await exchange(this.fetch, {
          grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
        }, tokens),
      };
      this.cached = session;
      this.needsSave = true;
    }
    if (this.needsSave) {
      await saveSession(this.path, session);
      this.needsSave = false;
    }
    this.cached = session;
    return session;
  }
}

module.exports = { login, request, saveSession, Session };

