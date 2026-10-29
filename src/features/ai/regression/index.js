'use strict';

const gate = require('./regression.gate');
const { computeGlobalHash, readDefaultPair, overrideVersions } = require('./globalHash');
const { registerSettingsGuard } = require('./settingsGuard');
const settings = require('./regression.settings');
const errors = require('./regression.errors');

registerSettingsGuard();

/** Regressão obrigatória ao trocar prompt, modelo ou provider (M9-D033): hashes, trava da troca e erros. */
module.exports = { ...gate, computeGlobalHash, readDefaultPair, overrideVersions, registerSettingsGuard, ...settings, errors };
