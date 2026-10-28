'use strict';

const { Op } = require('sequelize');
const { IntegrationConnection } = require('../../../models');
const { assertRefFormat, assertRefBelongsToCompany } = require('./secretRef');
const { refShared } = require('./secrets.errors');
const { readSecretParams } = require('./secretParams');

/**
 * Validação da referência ao gravar uma connection (M9-D202 regras 1 e 6): formato, empresa dona e
 * não compartilhada. `legacy` é só a ponte do Correspondente (referências antigas "vault:...").
 */
async function validarSecretRefDaConexao({ secretRef, companyId, connectionId, legacy, ctx, transaction }) {
  if (!secretRef || legacy) return;
  assertRefFormat(secretRef);
  const { requireCompanyPrefix } = await readSecretParams(ctx, transaction);
  assertRefBelongsToCompany(secretRef, companyId, { requirePrefix: requireCompanyPrefix });
  const where = { companyId, secretRef, ...(connectionId ? { id: { [Op.ne]: connectionId } } : {}) };
  if (await IntegrationConnection.findOne({ where, transaction })) throw refShared();
}

module.exports = { validarSecretRefDaConexao };
