'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { openTenantTx } = require('../../../core-governance/data-quality/retention.tenantTx');
const { getSetting } = require('../../../settings/settings.service');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('../ingest.settings');
const errors = require('../ingest.errors');

const PLACEHOLDER = INGEST_SETTING_DEFAULTS[KEYS.LEGACY_VALUE];
const normalize = (value) => String(value === undefined || value === null ? '' : value).trim().toLowerCase();

/**
 * O código da empresa no sistema antigo é único no grupo (M9-D900, LEVE-D): dois iguais fariam uma empresa ler as linhas da outra. Os parâmetros são isolados por empresa (RLS),
 * então cada empresa irmã é lida na transação dela. Lança 409 `GOV_MIG_LEGACY_CODE_DUPLICATE` quando outra empresa do grupo usa o mesmo código (sem caixa nem espaços).
 * O padrão `A_DEFINIR` e o vazio nunca contam como código.
 * Corrida (R3-L5): a conferência lê o que as irmãs já confirmaram; duas gravações simultâneas do mesmo código não se enxergariam. Por isso a conferência toma, antes de ler, uma trava
 * de transação do grupo, que só cai quando a gravação confirma (ou desfaz): a segunda espera a primeira e então enxerga o código dela.
 */
async function assertCodeAvailable(tenant, code, transaction) {
  const wanted = normalize(code);
  if (!wanted || wanted === normalize(PLACEHOLDER)) return;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { type: QueryTypes.SELECT, transaction, replacements: { key: `mig_legacy_code:${tenant.groupId}` } });
  const siblings = await sequelize.query('SELECT id FROM core.companies WHERE group_id = :groupId AND id <> :companyId AND deleted_at IS NULL', {
    type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId },
  });
  for (const sibling of siblings) {
    const other = { groupId: tenant.groupId, companyId: sibling.id };
    const value = await openTenantTx(other, (tx) => getSetting(KEYS.LEGACY_VALUE, other, tx, null));
    if (normalize(value) === wanted) throw errors.legacyCodeDuplicate();
  }
}

module.exports = { assertCodeAvailable };
