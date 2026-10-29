'use strict';

const { definePort } = require('../ports/definePort');

/** Port StorageAdapter (domínio STORAGE, M9-D209): operações, entradas e saída normalizada versionadas. */
const StorageAdapter = definePort('StorageAdapter', 'STORAGE', {
  putObject: ['key'],
  getObject: ['key'],
  deleteObject: ['key'],
  headObject: ['key'],
  getSignedUrl: ['key'],
});

module.exports = { StorageAdapter };
