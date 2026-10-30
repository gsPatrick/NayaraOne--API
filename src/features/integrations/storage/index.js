'use strict';

/** Armazenamento de objetos atrás do port StorageAdapter (Marco 9, M9-D242). Fachada: os módulos de negócio só falam com este arquivo. */
const service = require('./storage.service');
const { resolveStorage, ensureStorageRegistered } = require('./storage.resolve');
const { readStorageParams, PADROES } = require('./storage.params');
const { STORAGE_SETTINGS_SCHEMA } = require('./storage.settings');
const { buildKey, assertCompanyKey } = require('../providers/storage/storage.key');

module.exports = { ...service, resolveStorage, ensureStorageRegistered, readStorageParams, STORAGE_PADROES: PADROES, STORAGE_SETTINGS_SCHEMA, buildKey, assertCompanyKey };
