'use strict';

// Marco 9, M9-D258 / M9-D256 — a pergunta 2 usa o estado do portão (listReleaseStates) lido do banco descartável com RLS real; fora dele nada é dado como liberado.
process.env.PORT = process.env.M9D258_PORTAO_PORT || '21758';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const env = require('../_helpers/m9d256Env');
const { consultarPortao } = require('../../../scripts/int-autocheck/lib/ambientePortao');
const { compute } = require('../../../scripts/int-autocheck/lib/compute');
const { ambienteVerde } = require('../_helpers/m9d258Ambiente');

const RAIZ = path.join(__dirname, '..', '..', '..');
const NO_BANCO_DESCARTAVEL = process.env.DISPOSABLE_DB !== '1' && 'precisa de banco descartável (DISPOSABLE_DB=1): o .env da API aponta para a homologação remota';
let tenant;

before(async () => { if (!NO_BANCO_DESCARTAVEL) ({ tenant } = await env.carregarTenants()); });
after(async () => { await env.admin().close().catch(() => {}); await env.sequelize.close().catch(() => {}); setTimeout(() => process.exit(0), 1500); });

test('autocheck_portao_so_e_consultado_em_banco_descartavel_e_usa_list_release_states', { skip: NO_BANCO_DESCARTAVEL }, async () => {
  // Fora do banco descartável: nenhuma consulta, todos os providers pendentes, a condição continua impressa.
  const antes = process.env.DISPOSABLE_DB;
  process.env.DISPOSABLE_DB = '';
  const semBanco = await consultarPortao(RAIZ);
  process.env.DISPOSABLE_DB = antes;
  assert.equal(semBanco.consultado, false);
  assert.equal(semBanco.familiasLiberadas, 0);
  assert.equal(semBanco.familiasTotal, 14);
  assert.equal(semBanco.naoLiberados.length, 32);
  // No banco descartável, com duas connections de produção liberadas em famílias diferentes (empresa do seed).
  await env.desfazerLiberacoes(tenant);
  // A connection nasce em SANDBOX (criar em produção exige MFA, que este teste não usa) e o fixture a coloca em PRODUÇÃO já liberada, como o serviço de liberação deixa.
  for (const providerCode of ['messaging-sandbox', 'bank-sandbox']) {
    const c = await env.comTenant(tenant, (t) => env.registry.createConnection({ providerCode, environment: 'SANDBOX', label: `QA-M9 PORTAO ${env.uniqueSuffix()}` }, env.ctxDe(tenant), t));
    await env.sql(tenant, "UPDATE integration.connections SET environment = 'PRODUCTION', production_released_at = now(), production_released_by = :u WHERE id = :id", { u: tenant.userId, id: c.id });
  }
  const estado = await consultarPortao(RAIZ);
  assert.equal(estado.consultado, true);
  assert.ok(estado.liberados.includes('messaging-sandbox') && estado.liberados.includes('bank-sandbox'));
  assert.ok(estado.familiasLiberadas >= 2 && estado.familiasLiberadas <= 14);
  assert.ok(!estado.naoLiberados.includes('messaging-sandbox') && estado.naoLiberados.includes('email-sandbox') === !estado.liberados.includes('email-sandbox'));
  assert.equal(estado.liberados.length + estado.naoLiberados.length, 32, 'cada provider do catálogo está em exatamente uma das listas');
  // A resposta da pergunta 2 imprime o X de 14 e a lista pendente vindos desse estado.
  const r = compute({ ambiente: ambienteVerde({ estadoDoPortao: () => estado }).amb });
  const p = r.perguntas.find((x) => x.n === 2);
  assert.match(p.resposta, new RegExp(`condicionado a homologação por provider: ${estado.familiasLiberadas} de 14 famílias`));
  assert.ok(estado.naoLiberados.every((c) => p.resposta.includes(c)));
});
