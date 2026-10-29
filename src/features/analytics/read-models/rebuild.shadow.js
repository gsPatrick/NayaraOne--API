'use strict';

/**
 * M9-D608 (3.2 passo 2) — tabela sombra `rm_<x>__rebuild`: criada e descartada pelas funções SECURITY DEFINER da migration 9701
 * (o role de runtime não tem CREATE no schema). Estrutura, índices únicos e RLS idênticos aos da tabela atual. Tudo o que entra nela
 * vem de `def.rebuild.keys` + `def.recompute`, com a fonte lida numa fotografia única (REPEATABLE READ).
 */
const { sequelize } = require('../../../models');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { upsertAggregate, keyText } = require('./readModel.upsert');

const shadowName = (model) => `${model}__rebuild`;

async function createShadow(model, transaction) {
  await sequelize.query('SELECT analytics.rebuild_shadow_create(:model)', { replacements: { model }, transaction });
  return shadowName(model);
}

async function dropShadow(model, transaction) {
  await sequelize.query('SELECT analytics.rebuild_shadow_drop(:model)', { replacements: { model }, transaction });
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
    await upsertAggregate(def, { ...scope, key, fields: result.fields, rows: result.rows, sourceSnapshotAt: result.sourceSnapshotAt || snapshotAt }, transaction, shadowName(def.name));
    rows += 1;
  }
  return { rows };
}

module.exports = { shadowName, createShadow, dropShadow, fillShadow };
