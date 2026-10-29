'use strict';

// M9-D034 pelo app real (cluster descartável, provider sandbox): o corretor pede a próxima ação e aceita a recomendação NEXT_ACTION só com
// ai:read (marca "vista", nenhuma tarefa nasce) e a trava de gravação de `ia.comercial.permitir_propostas` (409 AI_AGENT_NOT_HOMOLOGATED
// sem avaliação e homologação, 200 depois). Nunca chama MFA nem forja token.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const H = require('../_helpers/iaRunApiEnv');

let env; let tenant; let opp;
const CHAVE = 'ia.comercial.permitir_propostas';
const TOOLS = ['crm.getOpportunity', 'crm.getCustomerSummary', 'radar.listMatchesForOpportunity'];
const num = async (sql, params) => Number((await H.admin(sql, params)).rows[0].n);

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant } = await H.subir(Number(process.env.M9D034_HTTP_TEST_PORT) || 21934));
  opp = (await H.criarOportunidadeCommitada(tenant)).opp;
  // Sem nenhuma interação, o contato conta desde a abertura: 10 dias atrás passa dos 7 do alerta.
  await H.admin("UPDATE crm.opportunities SET created_at = now() - interval '10 days' WHERE id = $1", [opp.id]);
  await H.agenteAtivo(env, tenant, { code: 'NAY_COMERCIAL', tools: TOOLS });
});
after(async () => { await H.encerrar(env, [CHAVE]); });

const pedirAcao = (quem) => env.call('POST', '/ai/runs', env.tokens[quem], {
  agentCode: 'NAY_COMERCIAL', purpose: 'Próxima ação', input: 'Qual a próxima ação desta oportunidade?', taskType: 'sugerir_proxima_acao', context: { entityType: 'crmOpportunity', entityId: opp.id },
});

test('m9d034_aceitar_recomendacao_nao_cria_tarefa', { skip: SKIP }, async () => {
  const antes = await num('SELECT count(*) AS n FROM core.tasks WHERE related_entity_id = $1', [opp.id]);
  const res = await pedirAcao('A:checker');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.answer, /Retomar contato/);
  assert.equal(res.body.data.routingPath, 'RULE');
  const [proposta] = res.body.data.proposals;
  assert.equal(proposta.kind, 'NEXT_ACTION');
  // O corretor (ai:read, sem ai:approve) vê a recomendação dirigida a ele e a aceita como "vista".
  const lida = await env.call('GET', `/ai/recommendations/${proposta.id}`, env.tokens['A:checker']);
  assert.equal(lida.status, 200, JSON.stringify(lida.body));
  assert.equal(lida.body.data.status, 'PENDING');
  assert.equal(lida.body.data.recommendationType, 'NEXT_ACTION');
  assert.equal(lida.body.data.riskLevel, 'LOW');
  const aceita = await env.call('POST', `/ai/recommendations/${proposta.id}/accept`, env.tokens['A:checker'], {});
  assert.equal(aceita.status, 200, JSON.stringify(aceita.body));
  assert.equal(aceita.body.data.recommendation.status, 'ACCEPTED');
  const depois = await env.call('GET', `/ai/recommendations/${proposta.id}`, env.tokens['A:checker']);
  assert.equal(depois.body.data.status, 'ACCEPTED');
  assert.equal(depois.body.data.outcome, 'NOT_APPLICABLE', 'aceitar só marca como vista (sem ação proposta, nada é executado)');
  assert.equal(await num('SELECT count(*) AS n FROM core.tasks WHERE related_entity_id = $1', [opp.id]), antes, 'nenhuma tarefa criada');
  // Quem não é o destinatário não a aceita; sem ai:approve também não rejeita.
  const rej = await env.call('POST', `/ai/recommendations/${proposta.id}/reject`, env.tokens['A:checker'], { reason: 'Não serve para mim.' });
  assert.equal(rej.status, 403);
});

test('m9d034_ligar_permitir_propostas_exige_avaliacao_e_homologacao', { skip: SKIP }, async () => {
  const gestor = env.tokens['A:gestor'];
  const ligar = (valor) => env.call('PUT', `/settings/${CHAVE}`, gestor, { value: valor });
  const sem = await ligar(true);
  assert.equal(sem.status, 409, JSON.stringify(sem.body));
  assert.equal(sem.body.error.code, 'AI_AGENT_NOT_HOMOLOGATED');
  assert.equal((await ligar(false)).status, 200, 'desligar nunca é recusado');

  const pedido = await env.call('POST', '/ai/evaluations/run', gestor, { agentCode: 'NAY_COMERCIAL', suite: 'all' });
  assert.equal(pedido.status, 202, JSON.stringify(pedido.body));
  const id = pedido.body.data.evaluationRunId;
  let pronta;
  for (let i = 0; i < 80; i += 1) {
    pronta = await env.call('GET', `/ai/evaluations/${id}`, gestor);
    if (pronta.body.data && ['PASSED', 'FAILED', 'ERROR'].includes(pronta.body.data.status)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(pronta.body.data.status, 'PASSED', JSON.stringify(pronta.body.data.metrics));
  const semHumano = await ligar(true);
  assert.equal(semHumano.status, 409, 'avaliação verde sem homologação humana não basta');
  assert.equal(semHumano.body.error.code, 'AI_AGENT_NOT_HOMOLOGATED');

  const homologar = await env.call('POST', `/ai/evaluations/${id}/homologate`, env.tokens['A:maker'], { note: 'Piloto comercial aprovado.' });
  assert.equal(homologar.status, 200, JSON.stringify(homologar.body));
  const ok = await ligar(true);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const lida = await env.call('GET', `/settings/${CHAVE}`, gestor);
  assert.equal(lida.body.data.value, true);
  assert.equal((await ligar(false)).status, 200);
});
