'use strict';

// M9-D907 — parâmetro migracao.rollback.itens_por_pagina: declarado no dicionário de configurações, validado, no catálogo e lido pelo relatório. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d907Env');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const KEY = 'migracao.rollback.itens_por_pagina';
let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { A = (await env.loadTenants()).A; await env.cleanup(A); } });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { await env.sequelize.close(); });

test('m9d907 o parâmetro está no dicionário de configurações, no catálogo e na tela da aba Governança', () => {
  assert.deepEqual(SETTINGS_SCHEMA[KEY], { type: 'integer', min: 1, max: 1000 });
  const csv = fs.readFileSync(path.join(__dirname, '../../../../Maturacao/demandas/parametros.csv'), 'utf8');
  assert.match(csv, new RegExp(`^"${KEY.replace(/\./g, '\\.')}",.*"100".*M9-D907`, 'm'));
  const screen = path.join(__dirname, '../../../../NayaraOne--FRONT/app/painel/configuracoes/governancaMigracaoGroups.js');
  if (fs.existsSync(screen)) assert.ok(fs.readFileSync(screen, 'utf8').includes(KEY), 'campo na tela');
});

test('m9d907 o tamanho da página do relatório vem do parâmetro (padrão 100)', { skip: skip() }, async () => {
  await env.listTypes(A);
  await env.adminQuery("UPDATE governance.external_op_types SET entity = 'QA907_ENTITY' WHERE company_id = $1 AND code = 'PAYMENT_SENT'", [A.companyId]);
  await env.decide(A, 'GO');
  for (let i = 0; i < 7; i += 1) await env.record(A, { operation: 'submitPayment', reference: `p-${i}`, dangerous: true });
  assert.equal((await env.getReport(A, { type: 'PAYMENT_SENT' })).items.pageSize, 100);
  await env.setParam(A, KEY, 3);
  const page = await env.getReport(A, { type: 'PAYMENT_SENT', page: 3 });
  assert.deepEqual([page.items.pageSize, page.items.rows.length], [3, 1]);
  await assert.rejects(env.setParam(A, KEY, 0));
  await assert.rejects(env.setParam(A, KEY, 5000));
});
