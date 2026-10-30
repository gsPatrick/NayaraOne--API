'use strict';

/**
 * M9-D608 (3.2 passo 2) — tabela sombra `rm_<x>__rb<8 hex da empresa>` (uma por empresa e modelo, para dois rebuilds de empresas diferentes não se atropelarem; M9-D608 reabertura L-2): criada e descartada pelas funções SECURITY DEFINER da migrations 9701 e 9930
 * (o role de runtime não tem CREATE no schema). Estrutura, índices únicos e RLS idênticos aos da tabela atual. Tudo o que entra nela
 * vem de `def.rebuild.keys` + `def.recompute`, com a fonte lida numa fotografia única (REPEATABLE READ).
 */
const { sequelize } = require('../../../models');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { upsertAggregate, keyText } = require('./readModel.upsert');

/** Nome da sombra: modelo + 8 primeiros hex do id da empresa (a mesma regra da função SQL rebuild_shadow_create). */
const shadowName = (model, companyId) => `${model}__rb${String(companyId).replace(/-/g, '').slice(0, 8)}`;

async function createShadow(model, companyId, transaction) {
  await sequelize.query('SELECT analytics.rebuild_shadow_create(:model, CAST(:companyId AS uuid))', { replacements: { model, companyId }, transaction });
  return shadowName(model, companyId);
}

async function dropShadow(model, companyId, transaction) {
  await sequelize.query('SELECT analytics.rebuild_shadow_drop(:model, CAST(:companyId AS uuid))', { replacements: { model, companyId }, transaction });
}

/** Lê todos os agregados da fonte (sem teto de linhas: o rebuild é a janela pesada) e grava o ESTADO de cada um na sombra. Devolve a contagem. */
async function fillShadow(def, scope, { snapshotAt, now, asOfDate }, transaction) {
  await enableAnalyticsWriter(transaction);
  const keys = await def.rebuild.keys({ ...scope, transaction });
  const seen = new Set();
  let rows = 0;
  for (const key of keys) {
    const id = keyText(def, key);
    if (seen.has(id)) continue; // a mesma chave duas vezes na enumeração não duplica o agregado
    seen.add(id);
    const result = await def.recompute({ ...scope, key, limit: null, asOfDate, now, event: null, transaction });
    if (result && result.truncated) throw new Error(`Read model ${def.name}: recompute sem limite não pode devolver truncated.`);
    await upsertAggregate(def, { ...scope, key, fields: result.fields, rows: result.rows, sourceSnapshotAt: result.sourceSnapshotAt || snapshotAt }, transaction, shadowName(def.name, scope.companyId));
    rows += 1;
  }
  return { rows };
}

module.exports = { shadowName, createShadow, dropShadow, fillShadow };
