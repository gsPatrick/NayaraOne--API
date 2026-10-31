'use strict';

// Marco 9, M9-D203 (reabertura G1) — a deduplicação do webhook é por empresa: o mesmo id externo do mesmo fornecedor
// em duas empresas grava duas linhas e nenhuma vira "duplicado" por causa da outra. Banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, corpo, receber, prefixo } = require('../../integrations/inbox/inboxHelpers');
const { IntegrationWebhookInbox } = require('../../../src/models');

let tenant;
let outro;
const PROV = 'qa-m9-d203-prov';

before(async () => {
  ({ tenant, outro } = await carregarTenants());
  assert.ok(outro, 'o seed de duas empresas (seed-ci-two-tenants) precisa existir');
});
after(async () => { await sequelize.close(); });

const linhasDe = (t0, eventId) => comTenant(t0, (t) => IntegrationWebhookInbox.findAll({ where: { providerCode: PROV, externalEventId: eventId }, transaction: t }));

test('inbox_mesmo_id_em_duas_empresas_grava_duas_linhas', async () => {
  const id = prefixo();
  const a = await receber(tenant, PROV, id);
  const b = await receber(outro, PROV, id);
  assert.equal(a.status, 'accepted');
  assert.equal(b.status, 'accepted', 'o evento da empresa B não pode ser descartado por causa do mesmo id da A');
  assert.equal((await linhasDe(tenant, id)).length, 1);
  assert.equal((await linhasDe(outro, id)).length, 1);
});

test('inbox_resposta_nao_serve_de_oraculo_entre_empresas', async () => {
  const id = prefixo();
  await receber(tenant, PROV, id, { raw: corpo({ de: 'A' }) });
  const b = await receber(outro, PROV, id, { raw: corpo({ de: 'B' }) });
  assert.equal(b.status, 'accepted');
  assert.equal(b.mismatch, undefined, 'sem alarme de adulteração nem pista do evento da outra empresa');
});

test('inbox_dedup_continua_valendo_dentro_da_mesma_empresa', async () => {
  const id = prefixo();
  assert.equal((await receber(outro, PROV, id)).status, 'accepted');
  const segundo = await receber(outro, PROV, id);
  assert.equal(segundo.status, 'duplicate');
  assert.equal((await linhasDe(outro, id)).length, 1);
  const [a, b] = await Promise.all([receber(tenant, PROV, `${id}-c`), receber(tenant, PROV, `${id}-c`)]);
  assert.deepEqual([a.status, b.status].sort(), ['accepted', 'duplicate']);
});

test('inbox_unicidade_do_banco_inclui_a_empresa', async () => {
  const [rows] = await sequelize.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conrelid = 'integration.webhook_inbox'::regclass AND c.contype = 'u'`
  );
  assert.ok(rows.some((r) => /company_id, provider_code, external_event_id/.test(r.def)), 'UNIQUE (company_id, provider_code, external_event_id)');
  assert.ok(!rows.some((r) => /^UNIQUE \(provider_code, external_event_id\)$/.test(r.def)), 'a UNIQUE global antiga não existe mais');
});
