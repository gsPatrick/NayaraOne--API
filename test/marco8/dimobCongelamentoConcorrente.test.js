'use strict';

// Marco 8 — DIMOB: primeira exportação SIMULTÂNEA de lote antigo (fechado, sem modelo) com DUAS CONEXÕES REAIS.
// Os dados precisam estar commitados para uma transação enxergar a outra: só roda em banco descartável
// (DISPOSABLE_DB=1 ou CI). Fora disso os testes são pulados.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { sequelize, getSeedTenant } = require('../testHelpers');
const parameters = require('../../src/features/correspondent/parameters.service');
const dimob = require('../../src/features/correspondent/fiscal/dimob.service');
const { DimobBatch, DimobRecord, AuditLog } = require('../../src/models');

const DISPOSABLE = Boolean(process.env.DISPOSABLE_DB || process.env.CI);
const opts = DISPOSABLE ? {} : { skip: 'exige banco descartável (DISPOSABLE_DB=1)' };
let tenant;
let configOriginal;
before(async () => {
  if (!DISPOSABLE) return;
  tenant = await getSeedTenant();
  configOriginal = await committed(async (t) => (await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t)).commission.action);
});
after(async () => {
  // Os dados desta suíte são commitados: devolve a configuração fiscal ao que era, para não contaminar outros testes.
  if (DISPOSABLE && configOriginal) await configurar(configOriginal);
  await sequelize.close();
});

async function openTx() {
  const t = await sequelize.transaction();
  await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
  await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
  return t;
}
async function committed(fn) {
  const t = await openTx();
  try { const r = await fn(t); await t.commit(); return r; } catch (err) { await t.rollback(); throw err; }
}
const exportar = (id, t) => dimob.exportDimobFile(id, tenant.userId, tenant.groupId, tenant.companyId, t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function configurar(patch) {
  return committed(async (t) => {
    const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
    return parameters.updateCommission({ ...atual.commission.action, ...patch }, 'Teste de congelamento concorrente', tenant.userId, tenant.groupId, tenant.companyId, t);
  });
}

// Lote antigo: fechado, SEM modelo, com um registro (commitado).
async function loteAntigo(ano, version) {
  return committed(async (t) => {
    const ctx = { groupId: tenant.groupId, companyId: tenant.companyId };
    const lote = await DimobBatch.create({ ...ctx, referenceYear: ano, version, layoutVersion: 'DIMOB-2026-v1', status: 'CLOSED', snapshotHash: 'a'.repeat(64), createdBy: tenant.userId }, { transaction: t });
    await DimobRecord.create({ ...ctx, dimobBatchId: lote.id, sourceRefs: { commissionEntitlementId: randomUUID() }, amount: 100, recordType: 'CORRESPONDENT_COMMISSION', validationStatus: 'VALID' }, { transaction: t });
    return lote.id;
  });
}
async function estado(id) {
  return committed(async (t) => {
    const lote = await DimobBatch.findOne({ where: { id }, transaction: t });
    const congelamentos = await AuditLog.count({ where: { entityId: id, action: 'correspondent.dimob.file_model_frozen' }, transaction: t });
    return { lote, congelamentos };
  });
}

test('M8-DIMOB-CONC-01: duas conexões reais, a segunda entra depois que a primeira gravou mas antes do commit, com a configuração já mudada: arquivos idênticos e um único congelamento', opts, async () => {
  await configurar({ dimobFileColumns: ['contrato', 'valor_no_ano'], dimobFileDelimiter: ';', dimobFileNotice: 'Aviso 1' });
  const id = await loteAntigo(2051, 1);
  const tA = await openTx();
  let tB;
  try {
    const A = (await exportar(id, tA)).content; // A congela com a configuração 1 e ainda NÃO commitou
    await configurar({ dimobFileColumns: ['situacao'], dimobFileDelimiter: '|', dimobFileNotice: 'Aviso 2' }); // vira a configuração vigente
    tB = await openTx();
    const emB = exportar(id, tB); // B lê o lote ainda sem modelo e fica esperando A
    emB.catch(() => {});
    await sleep(500);
    await tA.commit();
    const B = (await emB).content;
    await tB.commit();
    assert.equal(B, A, 'os dois arquivos são idênticos byte a byte');
    assert.match(A, /\ncontrato;valor_no_ano\n/, 'ambos usam o modelo efetivamente gravado (configuração 1)');
    const { lote, congelamentos } = await estado(id);
    assert.equal(congelamentos, 1, 'uma única auditoria de congelamento');
    assert.equal(lote.fileModelJson.delimiter, ';');
    assert.match(A, new RegExp(`# modelo;${lote.fileModelHash}`), 'o hash do arquivo é o do modelo gravado');
  } finally {
    await tA.rollback().catch(() => {});
    if (tB) await tB.rollback().catch(() => {});
  }
});

test('M8-DIMOB-CONC-02: várias rodadas de exportações simultâneas (sem ordem forçada): sempre arquivos idênticos, um congelamento, modelo gravado = modelo usado', opts, async () => {
  for (let rodada = 0; rodada < 6; rodada += 1) {
    await configurar({ dimobFileColumns: rodada % 2 ? ['contrato', 'valor_no_ano'] : ['valor_no_ano', 'situacao'], dimobFileDelimiter: rodada % 2 ? ';' : '|', dimobFileNotice: `Rodada ${rodada}` });
    const id = await loteAntigo(2052, rodada + 1);
    const tA = await openTx();
    const tB = await openTx();
    try {
      // Cada transação commita assim que a sua exportação termina (a que perde a trava espera a outra commitar).
      const [ra, rb] = await Promise.all([
        exportar(id, tA).then(async (r) => { await tA.commit(); return r; }),
        exportar(id, tB).then(async (r) => { await tB.commit(); return r; }),
      ]);
      assert.equal(rb.content, ra.content, `rodada ${rodada}: arquivos idênticos`);
      const { lote, congelamentos } = await estado(id);
      assert.equal(congelamentos, 1, `rodada ${rodada}: um único congelamento`);
      assert.match(ra.content, new RegExp(`# modelo${lote.fileModelJson.delimiter.replace('|', '\\|')}${lote.fileModelHash}`));
      // exportação posterior continua igual
      const depois = await committed((t) => exportar(id, t));
      assert.equal(depois.content, ra.content);
      assert.equal((await estado(id)).congelamentos, 1, 'exportar de novo não congela outra vez');
    } finally {
      await tA.rollback().catch(() => {});
      await tB.rollback().catch(() => {});
    }
  }
});
