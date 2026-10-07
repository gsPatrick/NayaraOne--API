'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const procurementService = require('../src/features/procurement/procurement.service');
const { Quotation, PurchaseRequest, PurchaseRequestItem } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function withCommittedTenantTransaction(fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// BUG REAL CORRIGIDO (auditoria "loop até secar" ciclo 1 paralelo — módulo Compras/Procurement,
// 2026-10-06): `createQuotation` fazia TOCTOU sem lock — `Quotation.findOne({status:'OPEN'})`
// seguido de `Quotation.create` sem travar a PurchaseRequest. Duas chamadas concorrentes (duplo
// clique no botão "Abrir cotação", ou 2 abas) podiam ambas ler "nenhuma OPEN" e criar 2
// Quotation OPEN para a MESMA PurchaseRequest — não há constraint única em
// `quotations(purchase_request_id, status)`. Ofertas de fornecedores submetidas depois ficam
// espalhadas entre as duas cotações-irmãs, quebrando `compareOffers` (só olha uma quotationId) e
// permitindo adjudicar a mesma requisição duas vezes em cotações diferentes. Corrigido com
// `lock: transaction.LOCK.UPDATE` na PurchaseRequest em `createQuotation` — serializa as duas
// chamadas, a segunda espera o commit da primeira e reaproveita a OPEN já existente.
test('CICLO1-COMPRAS-01: duas chamadas concorrentes de createQuotation para a mesma PurchaseRequest resultam em uma única Quotation OPEN', async () => {
  const suffix = uniqueSuffix();
  let requestId = null;
  try {
    const request = await withCommittedTenantTransaction((t) =>
      procurementService.createPurchaseRequest(
        {
          groupId: tenant.groupId,
          companyId: tenant.companyId,
          items: [{ description: `CICLO1 item ${suffix}`, quantity: 10 }],
        },
        tenant.userId,
        t
      )
    );
    requestId = request.id;

    await withCommittedTenantTransaction((t) => procurementService.decidePurchaseRequest(requestId, 'APPROVED', tenant.userId, t));

    // Barreira: força as duas transações a terminarem a leitura (findByPk + lock) antes de
    // qualquer uma seguir para a criação — reproduz a corrida de verdade independentemente da
    // velocidade do banco, mesmo padrão já usado em ADV-L17 (adversarial.legal.test.js).
    // Barreira de sincronização de verdade (mesmo padrão de ADV-L17 em adversarial.legal.test.js):
    // intercepta o `Quotation.findOne` feito dentro do service e força as DUAS chamadas a
    // terminarem essa leitura antes de qualquer uma seguir para o `findByPk`/lock/create — sem
    // isso, a corrida depende de sorte de timing de I/O e pode nunca se materializar no teste
    // mesmo quando o bug existe.
    // Timeout de fallback: se a correção estiver ativa (lock pessimista na PurchaseRequest), a
    // 2ª chamada pode ficar bloqueada no `findByPk` ANTES de chegar no `findOne` interceptado —
    // nesse caso a barreira nunca fecha pelas duas pontas (a 1ª fica esperando a 2ª chegar).
    // Resolve sozinha depois de 1.5s para não travar o teste; a serialização em si (a 2ª só
    // chega ao `findOne` depois que a 1ª já comitou) já é a prova de que o lock está segurando.
    let liberarBarreira;
    const barreira = new Promise((resolve) => {
      liberarBarreira = resolve;
    });
    const timeoutFallback = setTimeout(() => liberarBarreira(), 1500);
    let pendentes = 2;
    const originalFindOne = Quotation.findOne.bind(Quotation);
    Quotation.findOne = async function interceptedFindOne(...args) {
      pendentes -= 1;
      if (pendentes === 0) liberarBarreira();
      await barreira;
      clearTimeout(timeoutFallback);
      return originalFindOne(...args);
    };

    const chamada = async () =>
      withCommittedTenantTransaction((t) => procurementService.createQuotation(requestId, tenant.userId, t));

    let resultados;
    try {
      resultados = await Promise.allSettled([chamada(), chamada()]);
    } finally {
      Quotation.findOne = originalFindOne;
    }
    const ok = resultados.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 2, `as duas chamadas devem retornar com sucesso (reaproveitando a mesma OPEN): ${JSON.stringify(resultados.map((r) => r.status === 'rejected' ? String(r.reason) : 'ok'))}`);
    assert.equal(ok[0].value.id, ok[1].value.id, 'as duas chamadas concorrentes precisam retornar a MESMA Quotation (nunca duas OPEN para a mesma requisição)');

    const openCount = await withCommittedTenantTransaction((t) =>
      Quotation.count({ where: { purchaseRequestId: requestId, status: 'OPEN' }, transaction: t })
    );
    assert.equal(openCount, 1, 'só pode existir UMA Quotation OPEN por PurchaseRequest, mesmo sob concorrência real');
  } finally {
    if (requestId) {
      await withCommittedTenantTransaction(async (t) => {
        await Quotation.destroy({ where: { purchaseRequestId: requestId }, transaction: t, force: true });
        await PurchaseRequestItem.destroy({ where: { purchaseRequestId: requestId }, transaction: t, force: true });
        await PurchaseRequest.destroy({ where: { id: requestId }, transaction: t, force: true });
      });
    }
  }
});
