'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { getSetting } = require('../../../settings/settings.service');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('../ingest.settings');
const errors = require('../ingest.errors');
const { assertCodeAvailable } = require('./company.code');

const PLACEHOLDER = INGEST_SETTING_DEFAULTS[KEYS.LEGACY_VALUE];
const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, INGEST_SETTING_DEFAULTS[key]);

/**
 * Filtro de empresa das leituras do sistema antigo (M9-D900, auditoria M6). O legado é um só para todo o grupo; com o filtro ligado cada empresa lê apenas as linhas cuja
 * coluna `migracao.legado.coluna_empresa` vale `migracao.legado.codigo_empresa`. Devolve { scope, unfilteredMulti }: `scope` é { column, value } ou null (legado de uma empresa
 * só); `unfilteredMulti` é true quando o grupo tem várias empresas e o administrador desligou a exigência do filtro (o pedido de execução o audita).
 * Falha fechada: filtro ligado sem o código trocado do padrão = 422; código repetido em outra empresa do grupo = 409; filtro desligado em grupo com mais de uma empresa (e
 * `exigir_filtro_multiempresa` ligado) = 422.
 */
async function describeScope(tenant, transaction) {
  if (await read(KEYS.LEGACY_FILTER, tenant, transaction) === true) {
    const column = String(await read(KEYS.LEGACY_COLUMN, tenant, transaction));
    const value = String(await read(KEYS.LEGACY_VALUE, tenant, transaction)).trim();
    if (!value || value === PLACEHOLDER) throw errors.legacyScopeInvalid();
    await assertCodeAvailable(tenant, value, transaction);
    return { scope: { column, value }, unfilteredMulti: false };
  }
  const [row] = await sequelize.query('SELECT count(*)::int AS n FROM core.companies WHERE group_id = :groupId', { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId } });
  if (row.n <= 1) return { scope: null, unfilteredMulti: false };
  if (await read(KEYS.LEGACY_REQUIRE, tenant, transaction) !== false) throw errors.legacyScopeRequired();
  return { scope: null, unfilteredMulti: true };
}

const resolveScope = async (tenant, transaction) => (await describeScope(tenant, transaction)).scope;

module.exports = { resolveScope, describeScope };
