'use strict';

const { refInvalid, refForeignCompany } = require('./secrets.errors');

/** Formato e isolamento da referência do cofre (M9-D202 regra 1 e 6). Função pura, sem banco. */

const REF_RE = /^[a-z0-9][a-z0-9/_-]{5,158}$/;
const COMPANY_PREFIX_RE = /^company\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;
const WEBHOOK_SUFFIX = '/webhook-secret';

const isValidRef = (ref) => typeof ref === 'string' && REF_RE.test(ref);

/** O segredo do webhook é a referência irmã ".../webhook-secret" (regra 7): outra referência, nunca a mesma. */
const webhookRefOf = (ref) => `${ref}${WEBHOOK_SUFFIX}`;

function assertRefFormat(ref) {
  if (!isValidRef(ref)) throw refInvalid();
  if (!isValidRef(webhookRefOf(ref))) throw refInvalid('Referência do cofre longa demais: deixe espaço para o sufixo "/webhook-secret" (até 143 caracteres).');
}

const companyOfRef = (ref) => {
  const m = COMPANY_PREFIX_RE.exec(String(ref || ''));
  return m ? m[1] : null;
};

/**
 * Referência com prefixo `company/<id>/` só vale para a empresa dona do prefixo. Sem prefixo, só passa
 * quando o administrador desligou `integration.secret.require_company_prefix`.
 */
function assertRefBelongsToCompany(ref, companyId, { requirePrefix }) {
  const dono = companyOfRef(ref);
  if (dono && dono !== String(companyId).toLowerCase()) throw refForeignCompany();
  if (!dono && requirePrefix) throw refInvalid('A referência do cofre deve começar por "company/<id da empresa>/".');
}

module.exports = { REF_RE, WEBHOOK_SUFFIX, isValidRef, webhookRefOf, assertRefFormat, companyOfRef, assertRefBelongsToCompany };
