'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { getSetting } = require('../../../settings/settings.service');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('../ingest.settings');
const errors = require('../ingest.errors');

const PLACEHOLDER = INGEST_SETTING_DEFAULTS[KEYS.LEGACY_VALUE];
const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, INGEST_SETTING_DEFAULTS[key]);

/**
 * Filtro de empresa das leituras do sistema antigo (M9-D900, auditoria M6). O legado é um só para todo o grupo; com o filtro ligado cada empresa lê apenas as linhas cuja
 * coluna `migracao.legado.coluna_empresa` vale `migracao.legado.codigo_empresa`. Devolve { column, value } ou null (legado de uma empresa só).
 * Falha fechada: filtro ligado sem o código trocado do padrão = 422; filtro desligado em grupo com mais de uma empresa (e `exigir_filtro_multiempresa` ligado) = 422.
 */
async function resolveScope(tenant, transaction) {
  if (await read(KEYS.LEGACY_FILTER, tenant, transaction) === true) {
    const column = String(await read(KEYS.LEGACY_COLUMN, tenant, transaction));
    const value = String(await read(KEYS.LEGACY_VALUE, tenant, transaction)).trim();
    if (!value || value === PLACEHOLDER) throw errors.legacyScopeInvalid();
    return { column, value };
  }
  if (await read(KEYS.LEGACY_REQUIRE, tenant, transaction) !== false) {
    const [row] = await sequelize.query('SELECT count(*)::int AS n FROM core.companies WHERE group_id = :groupId', { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId } });
    if (row.n > 1) throw errors.legacyScopeRequired();
  }
  return null;
}

module.exports = { resolveScope };
