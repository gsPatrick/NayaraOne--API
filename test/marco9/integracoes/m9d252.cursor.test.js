'use strict';

// Marco 9, M9-D252 — teste adversarial 15 do livro (seção 19): a sincronização cai no meio de uma página e retoma do cursor correto, com 0 perdas e 0 duplicatas; cai de novo numa página
// posterior (checkpoint da anterior), e uma execução repetida depois de completa não duplica. Banco descartável (os ciclos COMMITAM).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, uniqueSuffix } = require('../../testHelpers');
const { OutboxEvent, IntegrationProvider, IntegrationSyncCursor } = require('../../../src/models');
const registry = require('../../../src/features/integrations/registry/registry.service');
const settingsService = require('../../../src/features/settings/settings.service');
const { publishDomainEvent } = require('../../../src/engines/events/outbox');
const { runSyncCycle } = require('../../../src/features/integrations/sync/sync.runner');

let tenant;
let ctx;
const ativas = [];
const PREFIXO = `qa-m9-d252-${uniqueSuffix()}`;

async function comTenant(fn) {
  const t = await sequelize.transaction();
  try {
    for (const [k, v] of [['app.group_id', tenant.groupId], ['app.company_id', tenant.companyId], ['app.user_id', tenant.userId]]) await sequelize.query(`SET LOCAL ${k} = :v`, { replacements: { v }, transaction: t });
    const out = await fn(t);
    await t.commit();
    return out;
  } catch (err) { await t.rollback(); throw err; }
}

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  await comTenant((t) => settingsService.upsertSetting('integration.admin.mfa_on_prod_connection_change', false, tenant, tenant.userId, t));
});
after(async () => {
  await comTenant(async (t) => { await sequelize.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key LIKE 'integration.sync.%'", { replacements: { c: tenant.companyId }, transaction: t }); });
  await sequelize.close();
});

async function conexao() {
  const provider = await IntegrationProvider.findOne({ where: { domain: 'BANK', status: 'ACTIVE', sandboxAvailable: true } });
  assert.ok(provider, 'sem fornecedor sandbox bancário');
  return comTenant(async (t) => {
    await sequelize.query("UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = :p AND environment = 'SANDBOX' AND status = 'ACTIVE'", { replacements: { c: tenant.companyId, p: provider.code }, transaction: t });
    const c = await registry.createConnection({ providerCode: provider.code, environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}` }, ctx, t);
    await sequelize.query("UPDATE integration.connections SET status = 'ACTIVE' WHERE id = :id", { replacements: { id: c.id }, transaction: t });
    ativas.push(c.id);
    return c;
  });
}
const cursorDe = (connectionId, stream) => comTenant((t) => IntegrationSyncCursor.findOne({ where: { connectionId, stream }, transaction: t }));
const itensGravados = (run) => comTenant((t) => OutboxEvent.findAll({ where: { eventType: 'qa_m9.sync.item', aggregateType: run }, transaction: t }));

/** Fonte paginada em memória; a queda é injetada no item `falhaNoItem` da página `falhaNaPagina` (contada pelas chamadas de fetchPage). */
function fonte(run, total, { falhaNoItem = null, falhaNaPagina = null } = {}) {
  const ids = Array.from({ length: total }, (_, i) => `ext-${String(i + 1).padStart(4, '0')}`);
  const chamadas = [];
  return {
    chamadas,
    async fetchPage({ cursorValue, pageSize }) {
      chamadas.push({ cursorValue });
      const inicio = /^\d+$/.test(cursorValue || '') ? Number(cursorValue) : 0;
      const items = ids.slice(inicio, inicio + pageSize);
      const fim = inicio + items.length;
      return { items, nextCursor: String(fim), done: fim >= total };
    },
    async applyItems(items, { transaction }) {
      let novos = 0; let n = 0;
      for (const id of items) {
        n += 1;
        if (falhaNoItem && n === falhaNoItem && chamadas.length === falhaNaPagina) throw new Error('queda simulada');
        const key = `${run}:${id}`;
        const antes = await OutboxEvent.count({ where: { idempotencyKey: key }, transaction });
        await publishDomainEvent({ groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: run, aggregateId: tenant.userId, eventType: 'qa_m9.sync.item', payload: { id }, idempotencyKey: key }, transaction);
        if (!antes) novos += 1;
      }
      return novos;
    },
  };
}
const ciclo = (c, src) => runSyncCycle({ connectionId: c.id, stream: 'bank.statement', workerId: `w-${uniqueSuffix()}`, origin: 'SCHEDULER' }, ctx, src);
const semPerdaNemDuplicata = (linhas, total) => {
  const ids = linhas.map((e) => e.payloadJson.id).sort();
  assert.equal(ids.length, total, `${total} itens gravados`);
  assert.equal(new Set(ids).size, total, '0 duplicatas');
  assert.deepEqual(ids, Array.from({ length: total }, (_, i) => `ext-${String(i + 1).padStart(4, '0')}`), '0 perdas, todos os ids esperados');
};

test('adv_sync_cursor_retomado_sem_perda_e_sem_duplicata', async () => {
  await comTenant((t) => settingsService.upsertSetting('integration.sync.page_size', 50, tenant, tenant.userId, t));
  const c = await conexao();
  const run = `${PREFIXO}-a`;
  // Queda na página 2 (item 10 dela): a página 1 fica gravada e o cursor para nela; a página 2 reverte inteira.
  const r1 = await ciclo(c, fonte(run, 120, { falhaNoItem: 10, falhaNaPagina: 2 }));
  assert.equal(r1.status, 'FAILED');
  const parado = await cursorDe(c.id, 'bank.statement');
  assert.equal(parado.cursorValue, '50', 'o cursor parou no último checkpoint gravado');
  assert.equal((await itensGravados(run)).length, 50, 'a página que caiu reverteu por inteiro');
  // Retoma do cursor correto: não relê a página 1 e completa o restante.
  const src = fonte(run, 120);
  const r2 = await ciclo(c, src);
  assert.equal(src.chamadas[0].cursorValue, '50', 'retoma do cursor, não do início');
  assert.equal(r2.itemsWritten, 70);
  semPerdaNemDuplicata(await itensGravados(run), 120);
  assert.equal((await cursorDe(c.id, 'bank.statement')).cursorValue, '120');
  // Outra queda, agora na primeira página de uma nova rodada de 120 itens (outra série): retoma do início e fecha sem duplicar; repetir a execução completa não duplica nada.
  const run2 = `${PREFIXO}-b`;
  const c2 = await conexao();
  assert.equal((await ciclo(c2, fonte(run2, 120, { falhaNoItem: 3, falhaNaPagina: 1 }))).status, 'FAILED');
  assert.equal((await itensGravados(run2)).length, 0, 'queda na primeira página: nada gravado');
  await ciclo(c2, fonte(run2, 120));
  semPerdaNemDuplicata(await itensGravados(run2), 120);
  const c3 = await conexao();
  await ciclo(c3, fonte(run2, 120)); // outra connection relê a mesma série: a idempotência por id externo impede duplicata
  semPerdaNemDuplicata(await itensGravados(run2), 120);
});
