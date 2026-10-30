'use strict';

/** Identidade e autenticação atrás do port IdentityAdapter (Marco 9, M9-D242). Fachada: o domínio só fala com este arquivo. */
const { verifyToken, assertLocalLoginAllowed, ensureIdentityRegistered } = require('./identity.service');
const { externalIdentityState } = require('./identity.state');
const { readIdentityParams, PADROES } = require('./identity.params');
const { IDENTITY_SETTINGS_SCHEMA } = require('./identity.settings');

module.exports = { verifyToken, assertLocalLoginAllowed, ensureIdentityRegistered, externalIdentityState, readIdentityParams, IDENTITY_PADROES: PADROES, IDENTITY_SETTINGS_SCHEMA };
