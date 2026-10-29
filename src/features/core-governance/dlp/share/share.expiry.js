'use strict';

const repo = require('./share.repository');

/**
 * Passada do shareLinkExpiryJob numa empresa, na transação do job (M9-D823 §2b): link ACTIVE com prazo vencido vira EXPIRED e o pedido (export_jobs, kind SHARE) também, na mesma
 * transação. O acesso já recusa por expires_at sem esperar este job. Devolve { expired }.
 */
async function expireCompanyLinks(tenant, transaction) {
  return { expired: await repo.markExpiredDue(tenant.companyId, transaction) };
}

module.exports = { expireCompanyLinks };
