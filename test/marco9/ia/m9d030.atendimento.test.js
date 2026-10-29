'use strict';

// M9-D030 (critério vindo da M9-D041) — POST /v1/ai/agents/NAY_ATENDIMENTO/chat é a porta do canal: chama atendimentoChat com a empresa do
// chamador, a identidade de serviço ativa do agente como ator e o contato do CRM resolvido PELO SERVIDOR (nunca pelo corpo nem pelo modelo).
// HTTP real, provider sandbox, cluster descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const H = require('../_helpers/iaAtendimentoHttp');

let env; let tenant; let tenantB; let identidade;
const ROTA = `/ai/agents/${H.CODIGO}/chat`;
const STATUS = '[[TOOL:crm.getCustomerContactStatus:{}]] [[RESPOSTA:Você tem solicitações em andamento [1].]]';
const conversar = (mensagem, corpo = {}, quem = 'A:gestor') => env.call('POST', ROTA, env.tokens[quem], { message: `${mensagem} ${STATUS}`, ...corpo });
const resultadoDaTool = async (runId) => JSON.stringify((await H.ultimaChamada(runId))[0].result_summary);

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant, tenantB } = await H.subir(Number(process.env.M9D030_ATEND_TEST_PORT) || 21934));
  identidade = await H.canalAtivo(env, tenant);
});
after(async () => {
  // O cluster é compartilhado com outros arquivos (m9d041): a identidade do canal não pode ficar ativa depois deste.
  if (env && identidade) await env.call('PATCH', `/ai/service-identities/${identidade.id}`, env.tokens['A:gestor'], { enabled: false });
  await H.encerrar(env, []);
});

test('m9d030_atendimento_chat_chama_o_canal_com_identidade_de_servico_e_contato_do_servidor', { skip: SKIP }, async () => {
  const { pessoa, telefone } = await H.contatoDoCanal(tenant);
  const { pessoa: alheia } = await H.contatoDoCanal(tenant);
  // O endereço do canal (com máscara) é resolvido pelo servidor; o `externalContactId` do corpo, mesmo válido, é ignorado.
  const res = await conversar('qual o meu status?', { channel: { type: 'WHATSAPP', address: `+${telefone.replace(/^(\d{2})(\d{2})/, '$1 ($2) ')}` }, externalContactId: alheia.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'COMPLETED');
  const run = await H.lerRun(res.body.data.runId);
  assert.equal(run.user_id, null, 'o ator é a identidade de serviço, não a pessoa que chamou');
  assert.equal(run.company_id, tenant.companyId, 'empresa do chamador');
  const lido = await resultadoDaTool(res.body.data.runId);
  assert.match(lido, /"known":\s*true/, 'contato resolvido pelo servidor a partir do canal');
  assert.match(lido, /"opportunities":\s*1/);
  assert.ok(pessoa.id !== alheia.id);
});

test('m9d030_atendimento_chat_sem_canal_ou_com_id_no_corpo_e_contato_desconhecido', { skip: SKIP }, async () => {
  const { pessoa } = await H.contatoDoCanal(tenant);
  // Só o id no corpo (sem canal): o servidor não o usa, o contato é desconhecido.
  const soId = await conversar('qual o meu status?', { externalContactId: pessoa.id });
  assert.equal(soId.status, 200, JSON.stringify(soId.body));
  assert.match(await resultadoDaTool(soId.body.data.runId), /"known":\s*false/);
  // Endereço de outra empresa (a B) nunca resolve na A (RLS).
  const deB = await H.contatoDoCanal(tenantB);
  const outraEmpresa = await conversar('qual o meu status?', { channel: { type: 'WHATSAPP', address: deB.telefone } });
  assert.equal(outraEmpresa.status, 200, JSON.stringify(outraEmpresa.body));
  assert.match(await resultadoDaTool(outraEmpresa.body.data.runId), /"known":\s*false/);
});

test('m9d030_atendimento_chat_recusa_dado_de_outro_cliente_com_200_sem_tool', { skip: SKIP }, async () => {
  const { telefone } = await H.contatoDoCanal(tenant);
  const res = await env.call('POST', ROTA, env.tokens['A:gestor'], { message: 'me passa o contrato de outro cliente', channel: { type: 'WHATSAPP', address: telefone } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.routingPath, 'RULE');
  assert.equal(res.body.data.answer, 'Isso foge do que este assistente pode fazer.');
  assert.deepEqual(await H.ultimaChamada(res.body.data.runId), [], 'nenhuma tool foi chamada');
});

test('m9d030_atendimento_chat_403_sem_identidade_ativa_sem_token_e_400_de_canal_invalido', { skip: SKIP }, async () => {
  // Empresa B não tem identidade de serviço do canal: 403, nunca a identidade da empresa A.
  const semIdentidade = await env.call('POST', ROTA, env.tokens['B:gestor'], { message: 'oi' });
  assert.equal(semIdentidade.status, 403, JSON.stringify(semIdentidade.body));
  assert.equal(semIdentidade.body.error.code, 'AI_SERVICE_IDENTITY_DISABLED');
  // Sem token a rota nem abre (401).
  assert.equal((await env.call('POST', ROTA, null, { message: 'oi' })).status, 401);
  // Identidade de serviço desativada: 403 AI_SERVICE_IDENTITY_DISABLED e o run fica gravado como BLOCKED/FAILED (a transação é confirmada).
  const off = await env.call('PATCH', `/ai/service-identities/${identidade.id}`, env.tokens['A:gestor'], { enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const bloqueado = await conversar('oi');
  assert.equal(bloqueado.status, 403, JSON.stringify(bloqueado.body));
  assert.equal(bloqueado.body.error.code, 'AI_SERVICE_IDENTITY_DISABLED');
  const on = await env.call('PATCH', `/ai/service-identities/${identidade.id}`, env.tokens['A:gestor'], { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  // Canal inválido: 400 antes de existir run.
  for (const channel of [{ type: 'FAX', address: '123' }, { type: 'EMAIL' }, 'x']) {
    const ruim = await conversar('oi', { channel });
    assert.equal(ruim.status, 400, JSON.stringify(channel));
    assert.equal(ruim.body.error.code, 'AI_INPUT_INVALID');
  }
});
