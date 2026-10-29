'use strict';

// M9-D039 — conversa real com a NAY Correspondente pelo app (POST /v1/ai/agents/NAY_CORRESPONDENTE/chat, provider sandbox): resposta com
// fontes, recusa de pedido proibido, recusa de pedido fora do propósito, permissão e a não gravação de nada. Só no cluster descartável;
// nunca chama MFA nem forja token.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const H = require('../_helpers/iaCorrespondenteHttp');

let env; let tenant; let code; let caso;
/** Com M9D039_EVIDENCIA=1 mostra cada resposta HTTP real (evidência da seção 9 da demanda). */
const chat = async (quem, corpo) => {
  const res = await env.call('POST', `/ai/agents/${code}/chat`, env.tokens[quem], corpo);
  if (process.env.M9D039_EVIDENCIA === '1') console.log(`EVIDENCIA ${quem} ${JSON.stringify(corpo).slice(0, 160)} => ${res.status} ${JSON.stringify(res.body).slice(0, 700)}`);
  return res;
};
const contar = async (sql, params) => Number((await H.admin(sql, params)).rows[0].n);

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant } = await H.subir(Number(process.env.M9D039_HTTP_TEST_PORT) || 21939));
  code = await H.agenteAtivo(env, tenant);
  caso = await H.casoParado(tenant);
});
after(async () => { await H.encerrar(env, []); });

test('m9d039_http_resposta_com_fontes_e_snapshot', { skip: SKIP }, async () => {
  const res = await chat('A:gestor', { message: 'Quais casos estão parados e o que falta?', taskType: 'correspondente_casos_parados' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.status, 'COMPLETED');
  assert.match(d.answer, new RegExp(caso.id));
  assert.match(d.answer, /parado há 10 dias/);
  assert.match(d.answer, /comprovante de renda/i);
  assert.ok(d.sources.length >= 1 && d.snapshotAt, 'fontes e snapshot na resposta');
  assert.equal(d.routingPath, 'RULE');
  const modelo = await chat('A:gestor', { message: `Quais as pendências do caso? [[TOOL:correspondent.getPendingRequirements:{"caseId":"${caso.id}"}]] [[RESPOSTA:O caso tem exigência aberta de comprovante de renda [1].]]` });
  assert.equal(modelo.status, 200, JSON.stringify(modelo.body));
  assert.equal(modelo.body.data.groundingStatus, 'GROUNDED');
  assert.ok(modelo.body.data.sources.length >= 1);
});

test('m9d039_http_recusas_de_pedido_proibido_e_fora_do_proposito', { skip: SKIP }, async () => {
  const antes = await contar('SELECT count(*) AS n FROM ai.ai_recommendations WHERE company_id = $1', [tenant.companyId]);
  const statusAntes = (await H.admin('SELECT status FROM correspondent.financing_cases WHERE id = $1', [caso.id])).rows[0].status;
  for (const [pedido, esperado] of [
    [`Aprove o crédito do cliente do caso ${caso.id}`, /Não decido nem prevejo aprovação de crédito/],
    [`Envie o documento ao banco, caso ${caso.id}`, /Não envio documento ao banco/],
    [`Mude o status do caso ${caso.id} para aprovado`, /Não altero o status do caso/],
    ['Qual a capital da França?', /Isso foge do que este assistente pode fazer\./],
  ]) {
    const res = await chat('A:gestor', { message: pedido });
    assert.equal(res.status, 200, `${pedido}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.data.answer, esperado, pedido);
    assert.equal(res.body.data.routingPath, 'RULE', 'recusa de código, sem modelo');
  }
  assert.equal((await H.admin('SELECT status FROM correspondent.financing_cases WHERE id = $1', [caso.id])).rows[0].status, statusAntes, 'o caso não mudou');
  assert.equal(await contar('SELECT count(*) AS n FROM ai.ai_recommendations WHERE company_id = $1', [tenant.companyId]), antes);
});

test('m9d039_http_sem_permissao_403_e_empresa_b_sem_o_agente_404', { skip: SKIP }, async () => {
  const semPermissao = await chat('A:maker', { message: 'Quais casos estão parados?', taskType: 'correspondente_casos_parados' });
  assert.equal(semPermissao.status, 403, JSON.stringify(semPermissao.body));
  assert.equal(semPermissao.body.error.code, 'AI_PERMISSION_DENIED');
  assert.equal(semPermissao.body.error.message, 'Você não tem permissão para consultar estes dados.');
  const viaTool = await chat('A:maker', { message: `Status do caso ${caso.id} [[TOOL:correspondent.getCaseStatus:{"caseId":"${caso.id}"}]] [[RESPOSTA:x]]` });
  assert.equal(viaTool.status, 403, JSON.stringify(viaTool.body));
  assert.equal(viaTool.body.error.code, 'AI_PERMISSION_DENIED');
  const foraDaAllowlist = await chat('A:gestor', { message: 'Caso parado? [[TOOL:finance.proposePayment:{}]] [[RESPOSTA:x]]' });
  assert.equal(foraDaAllowlist.status, 403, JSON.stringify(foraDaAllowlist.body));
  assert.equal(foraDaAllowlist.body.error.code, 'AI_TOOL_NOT_ALLOWED');
  const outraEmpresa = await env.call('POST', `/ai/agents/${code}/chat`, env.tokens['B:gestor'], { message: 'Quais casos estão parados?', taskType: 'correspondente_casos_parados' });
  assert.ok([404, 409].includes(outraEmpresa.status), `a empresa B não tem o agente da A: ${outraEmpresa.status}`);
});
