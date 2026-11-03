'use strict';

// Marco 8 — DIMOB: o gatilho do lote fechado só aceita o preenchimento inicial de file_model_json E file_model_hash
// (as duas, no mesmo UPDATE) com todo o resto idêntico.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('../testHelpers');
const { DimobBatch } = require('../../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const MODELO = JSON.stringify({ layout: 'DIMOB-2026-v1', columns: ['contrato'], delimiter: ';', notice: '' });
const HASH = 'b'.repeat(64);

async function novoLote(t, ano, status = 'CLOSED') {
  return DimobBatch.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, referenceYear: ano, version: 1, layoutVersion: 'DIMOB-2026-v1', status, snapshotHash: 'a'.repeat(64), createdBy: tenant.userId },
    { transaction: t }
  );
}
const upd = (t, id, setExtra) => sequelize.query(
  `UPDATE "correspondent"."dimob_batches" SET ${setExtra} WHERE id = :id`, { replacements: { id }, transaction: t }
);
const preenche = "file_model_json = '" + MODELO + "'::jsonb, file_model_hash = '" + HASH + "'";

const OUTRAS = {
  created_by: "created_by = gen_random_uuid()",
  created_at: "created_at = created_at + interval '1 day'",
  group_id: 'group_id = gen_random_uuid()',
  company_id: 'company_id = gen_random_uuid()',
  reference_year: 'reference_year = reference_year + 1',
  version: 'version = version + 1',
  status: "status = 'DRAFT'",
  snapshot_hash: "snapshot_hash = '" + 'c'.repeat(64) + "'",
  layout_version: "layout_version = 'OUTRO'",
  id: 'id = gen_random_uuid()',
};

for (const [coluna, set] of Object.entries(OUTRAS)) {
  test(`M8-DIMOB-GATILHO-NEG-${coluna}: preencher o modelo E alterar ${coluna} no mesmo UPDATE é recusado e nada é gravado`, async () => {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const lote = await novoLote(t, 2060);
      await assert.rejects(upd(t, lote.id, `${preenche}, ${set}`), /fechado não pode ser alterado/);
    });
  });
}

test('M8-DIMOB-GATILHO-NEG-parcial: preencher só file_model_json ou só file_model_hash é recusado', async () => {
  for (const set of ["file_model_json = '" + MODELO + "'::jsonb", "file_model_hash = '" + HASH + "'"]) {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const lote = await novoLote(t, 2061);
      await assert.rejects(upd(t, lote.id, set), /fechado não pode ser alterado/);
    });
  }
});

test('M8-DIMOB-GATILHO-NEG-nada-gravado: depois de cada tentativa recusada (em savepoint) o lote segue sem modelo e intacto', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const lote = await novoLote(t, 2062);
    for (const set of Object.values(OUTRAS)) {
      await sequelize.query('SAVEPOINT tentativa', { transaction: t });
      await assert.rejects(upd(t, lote.id, `${preenche}, ${set}`), /fechado não pode ser alterado/);
      await sequelize.query('ROLLBACK TO SAVEPOINT tentativa', { transaction: t });
    }
    const [[linha]] = await sequelize.query('SELECT file_model_json, file_model_hash, created_by, status FROM "correspondent"."dimob_batches" WHERE id = :id', { replacements: { id: lote.id }, transaction: t });
    assert.equal(linha.file_model_json, null);
    assert.equal(linha.file_model_hash, null);
    assert.equal(linha.created_by, tenant.userId);
    assert.equal(linha.status, 'CLOSED');
  });
});

test('M8-DIMOB-GATILHO-POS: preencher as duas colunas sozinhas funciona uma vez; depois qualquer mudança é recusada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const lote = await novoLote(t, 2063);
    await upd(t, lote.id, preenche);
    const [[linha]] = await sequelize.query('SELECT file_model_hash FROM "correspondent"."dimob_batches" WHERE id = :id', { replacements: { id: lote.id }, transaction: t });
    assert.equal(linha.file_model_hash, HASH);
    const tentativas = [
      "file_model_json = '{}'::jsonb",
      "file_model_hash = '" + 'd'.repeat(64) + "'",
      preenche, // repetir o mesmo preenchimento também é alteração de lote fechado
      "file_model_json = NULL, file_model_hash = NULL",
      ...Object.values(OUTRAS),
    ];
    for (const set of tentativas) {
      await sequelize.query('SAVEPOINT tentativa', { transaction: t });
      await assert.rejects(upd(t, lote.id, set), /não pode ser alterado/, set);
      await sequelize.query('ROLLBACK TO SAVEPOINT tentativa', { transaction: t });
    }
  });
});

test('M8-DIMOB-GATILHO-RASCUNHO: rascunho continua podendo ser fechado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const lote = await novoLote(t, 2064, 'DRAFT');
    await upd(t, lote.id, "status = 'CLOSED'");
    const [[linha]] = await sequelize.query('SELECT status FROM "correspondent"."dimob_batches" WHERE id = :id', { replacements: { id: lote.id }, transaction: t });
    assert.equal(linha.status, 'CLOSED');
  });
});
