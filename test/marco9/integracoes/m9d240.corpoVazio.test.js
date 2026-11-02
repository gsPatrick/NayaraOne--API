'use strict';

// Marco 9, M9-D240 (reabertura C1 da captura ao vivo) — PATCH /provider-accounts/:id com corpo vazio responde 400 em português,
// nunca 200 sem alterar nada. HTTP real; roda em banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D240_VAZIO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d249Env');

const sufixo = Date.now().toString(36);
let token;
let chamar;
let tenant;
let contaId;
const textoDe = (r) => JSON.stringify(r.corpo);

before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  token = env.tokenDe(tenant, ['correspondent:parameters']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const criada = await chamar(token, 'POST', '/provider-accounts', { providerCode: 'sandbox', label: `QA-M9 conta vazia ${sufixo}`, secretRef: 'vault:nayara/fin/sandbox' });
  assert.equal(criada.status, 201, textoDe(criada));
  contaId = criada.corpo.data?.id ?? criada.corpo.id;
});

after(async () => {
  await env.sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE id = :id", { id: contaId }).catch(() => {});
  await env.sequelize.close();
  process.exit(0);
});

test('conta_do_provider_edicao_sem_campo_da_400_e_com_campo_da_200', async () => {
  for (const corpo of [{}, { campoDesconhecido: 'x' }]) {
    const vazio = await chamar(token, 'PATCH', `/provider-accounts/${contaId}`, corpo);
    assert.equal(vazio.status, 400, textoDe(vazio));
    assert.match(textoDe(vazio), /Informe ao menos um campo para alterar/i);
  }
  const ok = await chamar(token, 'PATCH', `/provider-accounts/${contaId}`, { label: `QA-M9 conta vazia ${sufixo} editada` });
  assert.equal(ok.status, 200, textoDe(ok));
  assert.match(textoDe(ok), /editada/);
  const ativa = await chamar(token, 'PATCH', `/provider-accounts/${contaId}`, { active: true });
  assert.equal(ativa.status, 200, textoDe(ativa));
});

test('conta_do_provider_edicao_de_conta_inexistente_segue_404', async () => {
  const r = await chamar(token, 'PATCH', '/provider-accounts/00000000-0000-4000-8000-000000000000', {});
  assert.equal(r.status, 404, textoDe(r));
});
