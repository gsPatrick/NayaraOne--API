'use strict';

/** Cofre de segredos das integrações (Marco 9, M9-D202). Fachada que reexporta a API pública. */
const { SecretValue, REDACTED } = require('./SecretValue');
const { createFileMountedStore } = require('./fileMountedStore');
const { createHttpVaultStore } = require('./httpVaultStore');
const store = require('./secretStoreFactory');
const policy = require('./secretPolicy');
const refs = require('./secretRef');
const incidents = require('./secretIncidents');
const cache = require('./secretCache');
const { readConnectionSecret } = require('./secretReader');
const { rotateStoredSecret } = require('./secretRotation');
const { rotateConnectionSecret } = require('./connectionRotation');
const { uniqueCanonicalRef } = require('./secretRefCanonical');
const { evaluateConnectionSecret, enforceSecretExpiry } = require('./secretExpiry');

module.exports = {
  SecretValue, REDACTED, createFileMountedStore, createHttpVaultStore,
  buildSecretStoreFromEnv: store.buildSecretStoreFromEnv, getSecretStore: store.getSecretStore,
  setSecretStoreForTests: store.setSecretStoreForTests, assertSecretStoreAtBoot: store.assertSecretStoreAtBoot,
  assertDriverAllowed: policy.assertDriverAllowed, isValidRef: refs.isValidRef, webhookRefOf: refs.webhookRefOf,
  registerSecretIncidentReporter: incidents.registerSecretIncidentReporter, clearSecretIncidentReporters: incidents.clearSecretIncidentReporters,
  clearSecretCache: cache.clearSecretCache,
  readConnectionSecret, rotateStoredSecret, rotateConnectionSecret, evaluateConnectionSecret, enforceSecretExpiry, uniqueCanonicalRef,
};
