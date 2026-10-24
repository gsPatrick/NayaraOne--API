'use strict';

/**
 * Proteção dos scripts do drill de restore: eles criam e alteram dados (fixtures, UPDATE de
 * teste de isolamento, confirmação de pagamento). Rodados avulsos, sem o orquestrador, usariam
 * o DATABASE_URL do .env — que aponta para o banco compartilhado de homologação. Só aceita um
 * banco local (127.0.0.1/localhost) cujo nome comece com "drill_".
 */

function assertDrillDatabase(databaseUrl, scriptName) {
  let url;
  try {
    url = new URL(databaseUrl || '');
  } catch (err) {
    throw new Error(`${scriptName}: DATABASE_URL ausente ou inválida — este script só roda contra o banco local do drill.`);
  }
  const host = url.hostname;
  const db = url.pathname.replace(/^\//, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !db.startsWith('drill_')) {
    throw new Error(
      `${scriptName}: recusado — DATABASE_URL aponta para ${host}/${db}. Os scripts do drill só rodam contra um banco ` +
      'local cujo nome comece com "drill_" (use scripts/restoreDrill/legalFullDrill.js).'
    );
  }
}

module.exports = { assertDrillDatabase };
