'use strict';

const { join } = require('node:path');

function sessionPath(storagePath) {
  return join(storagePath, 'homebridge-toyota', 'session.json');
}

module.exports = { sessionPath };
