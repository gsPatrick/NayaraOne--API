'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrões do parametros.csv: evidência completa exigida (livro), IP e user-agent só quando o fornecedor os fornece. */
const PADROES = Object.freeze({ exigirEvidencia: true, exigirIpUserAgent: false });

const flag = (v, padrao) => (v === undefined || v === null ? padrao : v === true || v === 'true');

async function readSignatureParams(tenant, transaction) {
  const [evidencia, ipUa] = await Promise.all([
    getSetting('legal.assinatura.exigir_evidencia_completa', tenant, transaction, PADROES.exigirEvidencia),
    getSetting('legal.assinatura.exigir_ip_user_agent', tenant, transaction, PADROES.exigirIpUserAgent),
  ]);
  return { exigirEvidencia: flag(evidencia, PADROES.exigirEvidencia), exigirIpUserAgent: flag(ipUa, PADROES.exigirIpUserAgent) };
}

module.exports = { PADROES, readSignatureParams };
