'use strict';

// Marco 9, M9-D226 — APIs administrativas da contingência (HTTP real, permissão real): lista das ativas e troca aprovada (MFA recente). Roda em banco descartável.
process.env.PORT = process.env.M9D226_HTTP_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d249Env');
const env226 = require('../_helpers/m9d226Env');

let tenants;
let chamar;
let tokenLe;
let tokenGerencia;
let tokenSem;

before(async () => {
  tenants = await env.carregarTenants();
  env226.contingency.installContingency();
  tokenLe = env.tokenDe(tenants.tenant, ['integration:read']);
  tokenGerencia = env.tokenDe(tenants.tenant, ['integration:read', 'integration:manage']);
  tokenSem = env.tokenDe(tenants.tenant, ['settings:read']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});
after(async () => { await env226.limparContingencias(tenants.tenant); await env226.desativarConexoesDeTeste(tenants.tenant); await env.sequelize.close(); process.exit(0); });

test('contingencia_http_lista_as_ativas_da_empresa', async () => {
  const { tenant } = tenants;
  const c = await env226.conexaoDe(tenant, 'messaging-sandbox');
  await env226.falhar(tenant, c.id, 5);
  const r = await chamar(tokenLe, 'GET', '/admin/integrations/contingency');
  assert.equal(r.status, 200);
  const item = r.corpo.data.find((i) => i.connectionId === c.id);
  assert.ok(item, 'a contingência da connection aparece na faixa de aviso');
  assert.deepEqual([item.mode, item.domain, item.scope], ['QUEUE_AND_ALTERNATE', 'MESSAGING', 'CONNECTION']);
  assert.ok(!JSON.stringify(item).includes('sanitizedPayload'), 'a visão não expõe a linha bruta');
  assert.equal((await chamar(tokenSem, 'GET', '/admin/integrations/contingency')).status, 403);
  if (tenants.outro) {
    const outro = await chamar(env.tokenDe(tenants.outro, ['integration:read']), 'GET', '/admin/integrations/contingency');
    assert.equal(outro.corpo.data.some((i) => i.connectionId === c.id), false, 'outra empresa não enxerga');
  }
});

test('contingencia_http_troca_aprovada_exige_permissao_e_mfa', async () => {
  const { tenant } = tenants;
  const id = '00000000-0000-4000-8000-000000000226';
  const sem = await chamar(tokenLe, 'POST', `/admin/integrations/contingency/dispatches/${id}/switch`, { approve: true });
  assert.equal(sem.status, 403, 'só integration:read não troca');
  assert.equal(sem.corpo.error?.code || sem.corpo.code, 'PERMISSION_DENIED');
  const semMfa = await chamar(tokenGerencia, 'POST', `/admin/integrations/contingency/dispatches/${id}/switch`, { approve: true });
  assert.ok([401, 403].includes(semMfa.status), `sem MFA recente a troca é recusada (${semMfa.status})`);
  assert.match(JSON.stringify(semMfa.corpo), /MFA/);
  assert.ok(tenant.companyId);
});
