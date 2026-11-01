'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('../ingest.settings');
const errors = require('../ingest.errors');

const PLACEHOLDER = INGEST_SETTING_DEFAULTS[KEYS.LEGACY_VALUE];
const CONTEXT_COMPANY = "SELECT current_setting('app.company_id', true) AS value";
const normalize = (value) => String(value === undefined || value === null ? '' : value).trim().toLowerCase();

/**
 * O código da empresa no sistema antigo é único no grupo (M9-D900, LEVE-D): dois iguais fariam uma empresa ler as linhas da outra. Os parâmetros são isolados por empresa (RLS),
 * então cada irmã é lida sob o contexto dela. Lança 409 `GOV_MIG_LEGACY_CODE_DUPLICATE` quando outra empresa do grupo usa o mesmo código (sem caixa nem espaços).
 * O padrão `A_DEFINIR` e o vazio nunca contam como código.
 * Corrida (R3-L5): a conferência lê o que as irmãs já confirmaram; duas gravações simultâneas do mesmo código não se enxergariam. Por isso a conferência toma, antes de ler, uma trava
 * de transação do grupo, que só cai quando a gravação confirma (ou desfaz): a segunda espera a primeira e então enxerga o código dela.
 * Pool (R4-M1): tudo roda na conexão da transação do chamador, sem abrir outra por empresa irmã (quem segura a trava e pede uma segunda conexão esgota o pool e derruba a API). Para ler o
 * parâmetro de cada irmã sob a RLS, a conexão troca o contexto da empresa (`app.company_id`) para a irmã e o restaura ao fim, mesmo com erro.
 */
async function assertCodeAvailable(tenant, code, transaction) {
  const wanted = normalize(code);
  if (!wanted || wanted === normalize(PLACEHOLDER)) return;
  const q = (sql, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
  await q('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { key: `mig_legacy_code:${tenant.groupId}` });
  const siblings = await q('SELECT id FROM core.companies WHERE group_id = :groupId AND id <> :companyId AND deleted_at IS NULL', { groupId: tenant.groupId, companyId: tenant.companyId });
  if (!siblings.length) return;
  const [{ value: original }] = await q(CONTEXT_COMPANY);
  try {
    for (const sibling of siblings) {
      await q("SELECT set_config('app.company_id', :companyId, true)", { companyId: sibling.id });
      const [row] = await q('SELECT value FROM core.tenant_settings WHERE company_id = :companyId AND key = :key', { companyId: sibling.id, key: KEYS.LEGACY_VALUE });
      if (row && normalize(row.value) === wanted) throw errors.legacyCodeDuplicate();
    }
  } finally {
    await q("SELECT set_config('app.company_id', :companyId, true)", { companyId: original || '' }).catch(() => {});
  }
}

module.exports = { assertCodeAvailable };
