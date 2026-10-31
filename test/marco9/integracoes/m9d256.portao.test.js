'use strict';

// Marco 9, M9-D256 — portão de liberação para produção (HTTP real, MFA real do usuário de teste): evidências por item, relatório de versão anterior e contingência
// da família CRITICAL. Roda em banco descartável (COMMITA).
process.env.PORT = process.env.M9D256_PORTAO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d256Env');

const { sequelize, carregarTenants } = env;
let tenant;
let chamar;
let token;
const MENSAGERIA = 'messaging-sandbox';
const BANCO = 'bank-sandbox';

before(async () => {
  ({ tenant } = await carregarTenants());
  env.ligarPastas();
  env.secrets.setSecretStoreForTests(env.secrets.createHttpVaultStore({ mode: 'sandbox' }));
  token = env.tokenDe(tenant, ['integration:read', 'integration:manage']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await env.ativarMfa(tenant);
});
beforeEach(() => env.limparPastas());
after(async () => { env.secrets.setSecretStoreForTests(null); env.desligarPastas(); await env.admin().close(); await sequelize.close(); process.exit(0); });

const liberar = (id, t = token) => chamar(t, 'POST', `/admin/integrations/registry/connections/${id}/release`);

test('release_exige_todas_as_evidencias', async () => {
  await env.ativarMfa(tenant);
  await env.zerarSaudeDeLaboratorio(tenant, MENSAGERIA);
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA, { semSegredo: true, semSaida: true });
  // Nada pronto: a lista traz cada item que falta, com o motivo, e a connection continua não liberada.
  const nada = await liberar(c.id);
  assert.equal(nada.status, 409);
  assert.equal(nada.corpo.error.code, 'INTEGRATION_RELEASE_EVIDENCE_MISSING');
  assert.equal(nada.corpo.error.message, 'Faltam evidências para liberar esta integração em produção.');
  const itens = env.faltas(nada);
  for (const item of ['contractLive', 'contractTests', 'failureDrill', 'healthLab', 'secret', 'webhookSecret', 'egress']) assert.ok(itens.includes(item), `falta ${item}: ${itens}`);
  assert.ok(nada.corpo.error.details.missing.every((m) => m.item && m.code && m.message), 'cada item traz código e mensagem');
  assert.equal((await env.estadoDe(tenant, c.id)).production_released_at, null);
  // Exemplo do livro: tudo pronto menos o LIVE e o ensaio de falha, a lista tem exatamente 2 itens e a connection segue fora de produção.
  const d = await env.conexaoDeProducao(tenant, MENSAGERIA);
  await env.evidenciaCompleta(tenant, MENSAGERIA, { sem: ['contractLive', 'failureDrill'] });
  const dois = await liberar(d.id);
  assert.equal(dois.status, 409);
  assert.deepEqual(env.faltas(dois), ['contractLive', 'failureDrill']);
  assert.deepEqual(dois.corpo.error.details.missing.map((m) => m.code), ['INTEGRATION_CONTRACT_REPORT_MISSING', 'INTEGRATION_RELEASE_DRILL_MISSING']);
  // Cada item sozinho: tirar o relatório SANDBOX, a saúde verde, o segredo de webhook ou a rotação programada reprova só aquele item.
  await env.relatorioDeContrato(MENSAGERIA, 'LIVE');
  env.todosOsEnsaios(MENSAGERIA);
  assert.deepEqual(env.faltas(await liberar(d.id)), null, 'com tudo pronto o portão libera (conferido abaixo)');
});

test('release_libera_com_todas_as_evidencias_e_audita', async () => {
  await env.ativarMfa(tenant);
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA);
  await env.evidenciaCompleta(tenant, MENSAGERIA);
  const r = await liberar(c.id);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.data.productionReleasedBy, tenant.userId);
  assert.ok(r.corpo.data.productionReleasedAt);
  assert.equal(r.corpo.data.releaseState, 'RELEASED');
  const linha = await env.estadoDe(tenant, c.id);
  assert.ok(linha.production_released_at && linha.production_released_by === tenant.userId);
  const trilha = (await env.trilha(tenant, c.id, 'integration.connection.production_released'))[0];
  assert.ok(trilha, 'a liberação é auditada');
  assert.equal(trilha.before_json.productionReleasedAt, null);
  assert.ok(trilha.after_json.productionReleasedAt);
  assert.ok(!JSON.stringify(trilha).includes('secret_ref') && !/chave-/.test(JSON.stringify(trilha)), 'a trilha não leva segredo');
  const outra = await liberar(c.id);
  assert.equal(outra.status, 409);
  assert.equal(outra.corpo.error.code, 'INTEGRATION_RELEASE_ALREADY_RELEASED');
  // Liberada, a connection pode ser ativada em produção (antes a transição recusava).
  const ativa = await chamar(token, 'POST', `/admin/integrations/registry/connections/${c.id}/transition`, { status: 'ACTIVE', confirmation: { level: 3 } });
  assert.notEqual(ativa.corpo.error && ativa.corpo.error.code, 'INTEGRATION_PRODUCTION_NOT_RELEASED');
});

test('release_relatorio_de_versao_anterior_do_adapter_nao_vale', async () => {
  await env.ativarMfa(tenant);
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA);
  await env.evidenciaCompleta(tenant, MENSAGERIA);
  // O adapter mudou depois do ensaio de falha: o relatório antigo (outro hash) não vale e o item "failure drill" volta à lista.
  env.limparPastas();
  await env.relatorioDeContrato(MENSAGERIA, 'SANDBOX');
  await env.relatorioDeContrato(MENSAGERIA, 'LIVE');
  env.todosOsEnsaios(MENSAGERIA, { hash: 'a'.repeat(64) });
  const antigo = await liberar(c.id);
  assert.equal(antigo.status, 409);
  assert.deepEqual(env.faltas(antigo), ['failureDrill']);
  assert.equal(antigo.corpo.error.details.missing[0].code, 'INTEGRATION_RELEASE_DRILL_OUTDATED');
  // Ensaio reprovado também não vale; basta um cenário ausente.
  env.limparPastas();
  await env.relatorioDeContrato(MENSAGERIA, 'SANDBOX');
  await env.relatorioDeContrato(MENSAGERIA, 'LIVE');
  env.relatorioDeEnsaio(MENSAGERIA, 'provider-down');
  env.relatorioDeEnsaio(MENSAGERIA, 'rate-limit');
  env.relatorioDeEnsaio(MENSAGERIA, 'auth-failed', { passed: false });
  const parcial = await liberar(c.id);
  assert.deepEqual(env.faltas(parcial), ['failureDrill']);
  assert.match(JSON.stringify(parcial.corpo.error.details.missing[0].detail), /auth-failed.*timeout|timeout.*auth-failed/);
  // Relatório de contrato de adapter antigo (hash diferente) e de outra versão de API da connection também não valem.
  env.limparPastas();
  env.todosOsEnsaios(MENSAGERIA);
  await env.relatorioDeContrato(MENSAGERIA, 'SANDBOX', (rel) => ({ ...rel, adapterHash: 'b'.repeat(64) }));
  await env.relatorioDeContrato(MENSAGERIA, 'LIVE', (rel) => ({ ...rel, apiVersions: ['v0'] }));
  await env.sql(tenant, "UPDATE integration.connections SET api_version = 'v1' WHERE id = :id", { id: c.id });
  const contrato = await liberar(c.id);
  assert.deepEqual(env.faltas(contrato), ['contractLive', 'contractTests']);
  assert.deepEqual(contrato.corpo.error.details.missing.map((m) => m.code), ['INTEGRATION_CONTRACT_REPORT_API_VERSION', 'INTEGRATION_CONTRACT_REPORT_OUTDATED']);
  assert.equal((await env.estadoDe(tenant, c.id)).production_released_at, null);
});

test('release_connection_critical_sem_contingencia_recusada', async () => {
  await env.ativarMfa(tenant);
  await env.evidenciaCompleta(tenant, BANCO);
  const semPolitica = await env.conexaoDeProducao(tenant, BANCO);
  const r = await liberar(semPolitica.id);
  assert.equal(r.status, 409);
  assert.deepEqual(env.faltas(r), ['contingency'], 'INT-015: a família CRITICAL precisa de policy.contingency');
  // Política inválida (modo inexistente) também é recusada, com o problema apontado.
  // (o cadastro recusa política inválida; ela só chega ao portão por dado gravado antes das regras atuais)
  const invalida = await env.conexaoDeProducao(tenant, BANCO);
  await env.sql(tenant, 'UPDATE integration.connections SET policy_json = :p WHERE id = :id', { p: JSON.stringify({ egressHosts: ['api.exemplo-qa.com.br'], contingency: { mode: 'INVENTADO' } }), id: invalida.id });
  const i = await liberar(invalida.id);
  assert.deepEqual(env.faltas(i), ['contingency']);
  assert.match(JSON.stringify(i.corpo.error.details.missing[0].detail), /mode/);
  // Política válida libera.
  const valida = await env.conexaoDeProducao(tenant, BANCO, { policyJson: { contingency: env.CONTINGENCIA } });
  const ok = await liberar(valida.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
  // Família que não é CRITICAL (mensageria) não exige a política.
  await env.evidenciaCompleta(tenant, MENSAGERIA);
  const msg = await env.conexaoDeProducao(tenant, MENSAGERIA);
  assert.equal((await liberar(msg.id)).status, 200);
});
