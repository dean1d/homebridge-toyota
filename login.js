#!/usr/bin/env node
'use strict';

const { mkdir } = require('node:fs/promises');
const { dirname, isAbsolute } = require('node:path');
const { createInterface } = require('node:readline/promises');
const { Writable } = require('node:stream');
const { login, saveSession } = require('./auth');
const { ToyotaClient } = require('./toyota');

async function main() {
  const sessionFile = process.argv[2];
  if (process.argv.length !== 3 || !isAbsolute(sessionFile)) {
    throw new Error('Usage: homebridge-toyota-login <absolute-session-file-path>');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run this command in an interactive terminal.');
  }

  let hidden = false;
  const display = new Writable({
    write(chunk, _encoding, done) {
      if (!hidden) process.stdout.write(chunk);
      done();
    },
  });
  const terminal = createInterface({
    input: process.stdin, output: display, terminal: true, historySize: 0,
  });
  const secret = async (prompt) => {
    process.stdout.write(prompt);
    hidden = true;
    try {
      return await terminal.question('');
    } finally {
      hidden = false;
      process.stdout.write('\n');
    }
  };
  terminal.on('SIGINT', () => {
    terminal.close();
    process.exitCode = 130;
  });

  let session;
  try {
    const username = (await terminal.question('Toyota account email: ')).trim();
    const password = await secret('Toyota password (blank for OTP-only accounts): ');
    session = await login(globalThis.fetch, {
      username, password, askCode: async () => (await secret('Toyota verification code: ')).trim(),
    });
  } finally {
    terminal.close();
  }
  await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
  await saveSession(sessionFile, session);
  console.log('Toyota session saved.');
  const vehicles = await new ToyotaClient(sessionFile).vehicles();
  for (const { vin, modelName, modelYear, generation } of vehicles) {
    console.log([modelYear, modelName, vin, generation].filter(Boolean).join(' '));
  }
}

main().catch((error) => {
  console.error(error.constructor === Error ? error.message : 'Toyota setup failed. Check your connection and try again.');
  if (!process.exitCode) process.exitCode = 1;
});

