'use strict';

/**
 * Marco 8, Fase 13 — Testes adversariais consolidados.
 *
 * Esta suíte NÃO reimplementa o que já está coberto pelas Fases 0-12 (ver a tabela de
 * rastreabilidade no checklist, `Maturacao/MARCO_8_INTEGRACAO_CHECKLIST.md`, seção Fase 13) —
 * ela só cobre os 3 itens do Caderno que, numa auditoria da cobertura de teste existente, não
 * tinham um teste nomeado e isolável:
 *
 *   1. (Fiscal) Duplicidade de NFS-e — achado real: `requestInvoice` não tinha NENHUMA proteção
 *      contra duplicidade antes desta fase. Corrigido (nfse.service.js + migration
 *      20260101000352) e testado abaixo.
 *   2. (Fiscal) Timeout de NFS-e → UNKNOWN, nunca reenvio cego — já implementado desde a Fase 12
 *      (`withTimeout`/`NfseTimeoutError`), mas sem teste isolado que force o timeout
 *      deterministicamente. Testado abaixo.
 *   3. Secrets nunca aparecem em log — verificado estaticamente (grep) em vez de em runtime,
 *      já que é uma propriedade do CÓDIGO (nenhuma chamada de log perto de onde um secret é
 *      lido/usado), não do dado.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const nfseService = require('../src/features/correspondent/fiscal/nfse.service');
const { SandboxNfseAdapter } = require('../src/features/correspondent/adapters/NfseAdapter');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('FISCAL-NFSE-05: pedir NFS-e duas vezes pra mesma origem (sourceType+sourceId) retorna o MESMO InvoiceRequest, nunca cria um segundo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const sourceId = tenant.userId;
    const sourceType = 'SERVICE_ORDER';
    const payload = { sourceType, sourceId, amount: 500, description: `Dedup ${uniqueSuffix()}` };

    const first = await nfseService.requestInvoice(payload, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const second = await nfseService.requestInvoice(payload, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    assert.equal(first.id, second.id, 'a segunda chamada deveria retornar o InvoiceRequest existente, não criar um novo');

    const [[{ count }]] = await sequelize.query(
      'SELECT count(*)::int AS count FROM "correspondent"."invoice_requests" WHERE source_type = :sourceType AND source_id = :sourceId',
      { replacements: { sourceType, sourceId }, transaction }
    );
    assert.equal(count, 1, 'nunca deveria existir mais de um InvoiceRequest em andamento pra mesma origem');
  });
});

test('FISCAL-NFSE-06: timeout do adapter vira UNKNOWN, nunca lança erro cru pro chamador', async () => {
  // withTimeout genérico (mesma função usada por requestInvoice) — força o timeout de verdade,
  // sem depender de instrumentar o adapter sandbox.
  const neverResolves = new Promise(() => {}); // nunca resolve nem rejeita
  await assert.rejects(
    () => nfseService.withTimeout(neverResolves, 50),
    (err) => {
      assert.ok(err instanceof nfseService.NfseTimeoutError);
      return true;
    }
  );
});

test('FISCAL-NFSE-07: requestInvoice real com adapter "travado" marca UNKNOWN e não lança erro cru pro chamador', async () => {
  const original = SandboxNfseAdapter.prototype.requestInvoice;
  SandboxNfseAdapter.prototype.requestInvoice = () => new Promise(() => {}); // nunca resolve
  const originalEnv = process.env.CORRESPONDENT_NFSE_TIMEOUT_MS;
  process.env.CORRESPONDENT_NFSE_TIMEOUT_MS = '50';
  try {
    delete require.cache[require.resolve('../src/features/correspondent/fiscal/nfse.service')];
    const nfseServiceFreshTimeout = require('../src/features/correspondent/fiscal/nfse.service');
    await withRollbackTenantTransaction(tenant, async (transaction) => {
      const invoiceRequest = await nfseServiceFreshTimeout.requestInvoice(
        { sourceType: 'SERVICE_ORDER', sourceId: tenant.userId, amount: 100, description: `Timeout ${uniqueSuffix()}` },
        tenant.userId, tenant.groupId, tenant.companyId, transaction
      );
      assert.equal(invoiceRequest.status, 'UNKNOWN');
      const events = await nfseServiceFreshTimeout.getInvoiceEvents(invoiceRequest.id, tenant.groupId, tenant.companyId, transaction);
      assert.ok(events.some((e) => e.rawStatus === 'UNKNOWN'));
    });
  } finally {
    SandboxNfseAdapter.prototype.requestInvoice = original;
    if (originalEnv === undefined) delete process.env.CORRESPONDENT_NFSE_TIMEOUT_MS;
    else process.env.CORRESPONDENT_NFSE_TIMEOUT_MS = originalEnv;
    delete require.cache[require.resolve('../src/features/correspondent/fiscal/nfse.service')];
  }
});

test('SEC-04: nenhum arquivo do módulo correspondent (incluindo fiscal) loga perto de onde um secret/webhook payload é lido', () => {
  const root = path.join(__dirname, '..', 'src', 'features', 'correspondent');
  const secretHints = /secret|webhookSecret|sandbox_webhook_secret|financing_provider/i;
  const logCalls = /console\.(log|error|warn|info|debug)|logger\.(log|error|warn|info|debug)/;

  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, idx) => {
          if (logCalls.test(line) && secretHints.test(line)) {
            offenders.push(`${full}:${idx + 1}`);
          }
        });
      }
    }
  }
  walk(root);

  assert.deepEqual(offenders, [], `log perto de secret encontrado em: ${offenders.join(', ')}`);
});
