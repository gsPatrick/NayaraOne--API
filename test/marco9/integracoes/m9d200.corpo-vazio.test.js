'use strict';

// Marco 9, M9-D200 (reaberturas C1 e C4 da captura ao vivo) — corpo vazio na edição e corpo sem o status de destino na transição
// respondem 400 em português (nunca 200 sem alterar nada, nunca 409 com "undefined"). HTTP real; roda em banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D200_VAZIO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d249Env');

const base = '/admin/integrations/registry';
const sufixo = Date.now().toString(36);
let admin;
let plataforma;
let chamar;
let conexaoId;
let tenant;

const codigoDe = (r) => r.corpo.error?.code ?? r.corpo.code;
const textoDe = (r) => JSON.stringify(r.corpo);

before(async () => {
  const tenants = await env.carregarTenants();
  tenant = tenants.tenant;
  admin = env.tokenDe(tenants.tenant, ['integration:read', 'integration:manage']);
  plataforma = env.tokenDe(tenants.tenant, ['integration:read', 'integration:platform']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const criada = await chamar(admin, 'POST', `${base}/connections`, { providerCode: 'financing-sandbox', environment: 'SANDBOX', label: `QA-M9 vazio ${sufixo}` });
  assert.equal(criada.status, 201, textoDe(criada));
  conexaoId = criada.corpo.data?.id ?? criada.corpo.id;
});

after(async () => {
  await env.sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE id = :id", { id: conexaoId }).catch(() => {});
  await chamar(plataforma, 'PATCH', `${base}/providers/qa-m9-vazio-${sufixo}`, { status: 'DISABLED' });
  await env.sequelize.close();
  process.exit(0);
});

test('registro_edicao_de_connection_sem_campo_da_400_e_com_campo_da_200', async () => {
  for (const corpo of [{}, { environment: 'SANDBOX' }]) {
    const vazio = await chamar(admin, 'PATCH', `${base}/connections/${conexaoId}`, corpo);
    assert.equal(vazio.status, 400, textoDe(vazio));
    assert.match(textoDe(vazio), /Informe ao menos um campo para alterar/i);
    assert.ok(!/undefined/i.test(textoDe(vazio)));
  }
  const ok = await chamar(admin, 'PATCH', `${base}/connections/${conexaoId}`, { label: `QA-M9 vazio ${sufixo} editada` });
  assert.equal(ok.status, 200, textoDe(ok));
  assert.match(textoDe(ok), /editada/);
});

test('registro_edicao_de_fornecedor_sem_campo_da_400_e_com_campo_da_200', async () => {
  const codigo = `qa-m9-vazio-${sufixo}`;
  const criar = await chamar(plataforma, 'POST', `${base}/providers`, { code: codigo, displayName: 'QA-M9 vazio', domain: 'BANK', capabilities: [], supportedVersions: ['v1'], criticality: 'LOW', sandboxAvailable: true });
  assert.equal(criar.status, 201, textoDe(criar));
  const vazio = await chamar(plataforma, 'PATCH', `${base}/providers/${codigo}`, {});
  assert.equal(vazio.status, 400, textoDe(vazio));
  assert.match(textoDe(vazio), /Informe ao menos um campo para alterar/i);
  const ok = await chamar(plataforma, 'PATCH', `${base}/providers/${codigo}`, { displayName: 'QA-M9 vazio editado' });
  assert.equal(ok.status, 200, textoDe(ok));
});

test('registro_transicao_sem_o_status_de_destino_da_400_sem_a_palavra_undefined', async () => {
  for (const corpo of [{ to: 'ACTIVE' }, {}, { status: '' }, { status: 42 }]) {
    const r = await chamar(admin, 'POST', `${base}/connections/${conexaoId}/transition`, corpo);
    assert.equal(r.status, 400, `${JSON.stringify(corpo)} => ${textoDe(r)}`);
    assert.match(textoDe(r), /Informe o status de destino/i);
    assert.ok(!/undefined/i.test(textoDe(r)));
  }
  const semMudanca = await chamar(admin, 'GET', `${base}/connections/${conexaoId}`);
  assert.equal((semMudanca.corpo.data ?? semMudanca.corpo).status, 'DRAFT', 'nada mudou');
});

test('registro_transicao_realmente_invalida_segue_409_e_a_valida_segue_200', async () => {
  const invalida = await chamar(admin, 'POST', `${base}/connections/${conexaoId}/transition`, { status: 'PAUSED' });
  assert.equal(invalida.status, 409, textoDe(invalida));
  assert.equal(codigoDe(invalida), 'INTEGRATION_CONNECTION_INVALID_TRANSITION');
  // Outros testes do mesmo banco deixam uma ACTIVE do mesmo fornecedor e ambiente: a ativação do cenário precisa do espaço livre.
  await env.sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :co AND provider_code = 'financing-sandbox' AND environment = 'SANDBOX' AND status = 'ACTIVE' AND id <> :id", { co: tenant.companyId, id: conexaoId });
  const valida = await chamar(admin, 'POST', `${base}/connections/${conexaoId}/transition`, { status: 'ACTIVE' });
  assert.equal(valida.status, 200, textoDe(valida));
});
