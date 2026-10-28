'use strict';

const { sequelize } = require('../../../models');

/**
 * Consultas de apoio à retenção do conteúdo da NAY (M9-D028). Único lugar de retention/ que fala SQL (archGuard AI-004).
 * Sempre dentro da transação do tenant (RLS FORCE continua valendo).
 */
async function listAiConnectionRetentions(transaction) {
  const [rows] = await sequelize.query(
    `SELECT c.provider_code, c.config_json ->> 'data_retention' AS retention
       FROM integration.connections c JOIN integration.providers p ON p.code = c.provider_code
      WHERE p.domain = 'AI' AND c.config_json ? 'data_retention'`, { transaction }
  );
  return rows;
}

/** Chama a função de banco que expurga o conteúdo vencido da empresa da sessão; devolve { runs, sources }. */
async function purgeAiContentInDb({ publicDias, internalDias, confidentialDias, restrictedDias, caps, now }, transaction) {
  const [[{ r }]] = await sequelize.query(
    'SELECT ai.purge_ai_content(:pub, :int, :conf, :rest, CAST(:caps AS jsonb), CAST(:now AS timestamptz)) AS r',
    { replacements: { pub: publicDias, int: internalDias, conf: confidentialDias, rest: restrictedDias, caps: JSON.stringify(caps), now: now.toISOString() }, transaction }
  );
  return r;
}

module.exports = { listAiConnectionRetentions, purgeAiContentInDb };
