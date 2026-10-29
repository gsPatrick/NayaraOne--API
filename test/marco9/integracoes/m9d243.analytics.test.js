'use strict';

// Marco 9, M9-D243 — AnalyticsAdapter: payload sem dado pessoal, falha isolada do negócio e descarte depois de integration.analytics.drop_after_s.
// Banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparPendentes, instalar, restaurar, ler, config, limparConfig, dispatch,
} = require('../_helpers/m9d214Env');
const { programavel, erroHttp } = require('../_helpers/m9d214Scripted');
const { AnalyticsAdapter } = require('../../../src/features/integrations/providers/analytics/analytics.port');
const integrations = require('../../../src/features/integrations');

const CAPS = ['emitMetric', 'emitEvent', 'queryHealth'];
let tenant;
let An;
let conn;
const ctx = () => ctxDe(tenant);
const linhas = (sql, rep = {}) => comTenant(tenant, async (t) => (await sequelize.query(sql, { replacements: rep, transaction: t }))[0]);
const rodar = () => dispatch.runDispatchCycle(ctx());

before(async () => {
  restaurar(); // registra os adapters do boot e liga o descarte à rodada do worker
  ({ tenant } = await carregarTenants());
  conn = await conexaoAtiva(tenant, 'ANALYTICS');
  An = programavel(AnalyticsAdapter, 'analytics-sandbox', CAPS);
  instalar(An);
});
beforeEach(async () => { An.S.reset(); await limparPendentes(tenant); await limparConfig(tenant, ['integration.analytics.drop_after_s']); });
after(async () => { restaurar(); await sequelize.close(); });

const emitir = (fn, ...args) => comTenant(tenant, (t) => integrations.analytics[fn](ctx(), ...args, t));
const contarEnvios = async () => Number((await linhas("SELECT count(*)::int AS n FROM integration.dispatches WHERE connection_id = :c", { c: conn.id }))[0].n);

test('analytics_payload_sem_pii', async () => {
  const ok = await emitir('emitMetric', { name: 'leads.criados', value: 3, tags: { canal: 'site', empresaId: '0f9d0a4e-2f5b-4d57-8f7e-9a2f6a1c0b11', quantidade: 5 } });
  assert.equal(ok.emitted, true, JSON.stringify(ok));
  const envio = await ler(tenant, ok.dispatchId);
  assert.equal(envio.operation, 'emitMetric');
  assert.equal(envio.criticality_op, 'SAFE');
  assert.deepEqual(envio.payload_snapshot, { name: 'leads.criados', value: '3', tags: { canal: 'site', empresaId: '0f9d0a4e-2f5b-4d57-8f7e-9a2f6a1c0b11', quantidade: '5' } }, 'o número vira texto decimal no conteúdo aprovado');

  const antes = await contarEnvios();
  const comPii = [
    ['emitMetric', { name: 'leads.criados', value: 1, tags: { email: 'joao@exemplo.com.br' } }],
    ['emitMetric', { name: 'leads.criados', value: 1, tags: { contato: 'joao@exemplo.com.br' } }],
    ['emitEvent', { name: 'cliente.cadastrado', properties: { cpf: '123.456.789-09' } }],
    ['emitEvent', { name: 'cliente.cadastrado', properties: { observacao: 'ligar para 123.456.789-09' } }],
    ['emitEvent', { name: 'cliente.cadastrado', properties: { fone: '(41) 99999-0000' } }],
    ['emitEvent', { name: 'cliente.cadastrado', properties: { aninhado: { lista: ['ok', 'maria@exemplo.com'] } } }],
    ['emitEvent', { name: 'cliente.cadastrado', properties: { token: 'abc123' } }],
    ['emitMetric', { name: 'cobranca 123.456.789-09', value: 1 }],
  ];
  for (const [fn, dado] of comPii) {
    await assert.rejects(emitir(fn, dado), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_ANALYTICS_PII_BLOCKED' && e.message === 'Dado pessoal não pode ser enviado ao serviço de métricas.', JSON.stringify(dado));
  }
  assert.equal(await contarEnvios(), antes, 'nada que tenha dado pessoal chega a gravar envio');

  // Erro de aplicação: o stack sai redigido (D246) e o evento é aceito.
  const erro = new Error('Falha ao enviar para joao@exemplo.com.br com token Bear' + 'er abcdefghijklmnopqrstuvwxyz0123456789');
  erro.stack = `Error: ${erro.message}\n    at enviar (/app/src/x.js:10:5)\n    cpf 123.456.789-09`;
  const evento = await emitir('emitError', erro, { origem: 'teste' });
  assert.equal(evento.emitted, true);
  const texto = JSON.stringify((await ler(tenant, evento.dispatchId)).payload_snapshot);
  assert.ok(!texto.includes('joao@exemplo.com.br') && !texto.includes('abcdefghijklmnopqrstuvwxyz0123456789') && !texto.includes('123.456.789-09'));
  assert.ok(texto.includes('at enviar'), 'a pilha segue útil depois da redação');
});

test('analytics_falha_nao_afeta_negocio', async () => {
  const chave = 'integration.analytics.drop_after_s';
  // 1) Sem connection ativa de analytics: a emissão devolve o motivo e a transação do negócio segue e confirma.
  await comTenant(tenant, (t) => sequelize.query("UPDATE integration.connections SET status = 'PAUSED' WHERE id = :id", { replacements: { id: conn.id }, transaction: t }));
  const resultado = await comTenant(tenant, async (t) => {
    await config(tenant, chave, 300);
    const r = await integrations.analytics.emitMetric(ctx(), { name: 'x.y', value: 1 }, t);
    const seguinte = (await sequelize.query('SELECT 1 AS ok', { transaction: t }))[0][0].ok; // a transação não ficou abortada
    return { r, seguinte };
  });
  assert.equal(resultado.r.emitted, false);
  assert.equal(resultado.r.reason, 'INTEGRATION_CONNECTION_NOT_FOUND');
  assert.equal(resultado.seguinte, 1);
  const salvo = await linhas("SELECT value FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.analytics.drop_after_s'", { c: tenant.companyId });
  assert.equal(salvo.length, 1, 'o dado de negócio da mesma transação foi confirmado');

  // 2) Pedido inválido (valor que não é número): também não derruba o negócio.
  await comTenant(tenant, (t) => sequelize.query("UPDATE integration.connections SET status = 'ACTIVE' WHERE id = :id", { replacements: { id: conn.id }, transaction: t }));
  const invalido = await emitir('emitMetric', { name: 'x.y', value: 'muitos' });
  assert.equal(invalido.emitted, false);
  assert.equal(invalido.reason, 'INTEGRATION_PAYLOAD_INVALID');

  // 3) O serviço de métricas fora do ar na hora do envio: o envio é reagendado/terminado sem tocar no negócio.
  const emitido = await emitir('emitMetric', { name: 'leads.criados', value: 2 });
  An.S.fila('emitMetric', [{ erro: erroHttp(503) }]);
  const resumo = await rodar();
  assert.equal(resumo.sent, 0);
  assert.equal(resumo.errors, 0);
  const aposFalha = await ler(tenant, emitido.dispatchId);
  assert.ok(['RETRY_WAIT', 'FAILED'].includes(aposFalha.status), aposFalha.status);
  const negocio = await linhas("SELECT value FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.analytics.drop_after_s'", { c: tenant.companyId });
  assert.equal(negocio.length, 1, 'o dado de negócio continua lá');
});

test('analytics_descarta_apos_prazo', async () => {
  const velho = await emitir('emitMetric', { name: 'leads.antigo', value: 1 });
  const novo = await emitir('emitMetric', { name: 'leads.novo', value: 1 });
  const quase = await emitir('emitMetric', { name: 'leads.quase', value: 1 });
  await comTenant(tenant, (t) => sequelize.query(
    `UPDATE integration.dispatches SET created_at = now() - CASE id WHEN :velho THEN interval '301 seconds' WHEN :quase THEN interval '290 seconds' ELSE interval '1 second' END WHERE id IN (:velho, :novo, :quase)`,
    { replacements: { velho: velho.dispatchId, novo: novo.dispatchId, quase: quase.dispatchId }, transaction: t },
  ));
  An.S.fila('emitMetric', [{ resposta: { status: 'ACCEPTED', externalResourceId: 'm-1' } }]);
  const resumo = await rodar();
  assert.equal((await ler(tenant, velho.dispatchId)).status, 'CANCELLED', 'não enviada em 300 s: descartada');
  assert.equal(An.S.chamadas.filter((c) => c.request.name === 'leads.antigo').length, 0, 'e nunca chega ao serviço');
  assert.equal(resumo.sent, 2);
  assert.equal((await ler(tenant, novo.dispatchId)).status, 'CONFIRMED');
  assert.equal((await ler(tenant, quase.dispatchId)).status, 'CONFIRMED', '290 s ainda está dentro do prazo');
  const trilha = await linhas("SELECT reason FROM audit.audit_log WHERE entity_id = :id AND action = 'integration.dispatch.status_changed' ORDER BY occurred_at DESC LIMIT 1", { id: velho.dispatchId });
  assert.match(trilha[0].reason, /Descartada.*300 s/);

  // O prazo é parâmetro do administrador.
  await config(tenant, 'integration.analytics.drop_after_s', 60);
  const medio = await emitir('emitMetric', { name: 'leads.medio', value: 1 });
  await comTenant(tenant, (t) => sequelize.query("UPDATE integration.dispatches SET created_at = now() - interval '90 seconds' WHERE id = :id", { replacements: { id: medio.dispatchId }, transaction: t }));
  await rodar();
  assert.equal((await ler(tenant, medio.dispatchId)).status, 'CANCELLED', 'com prazo de 60 s, 90 s já é velho');
  await assert.rejects(config(tenant, 'integration.analytics.drop_after_s', 0), (e) => e.code === 'SETTING_INVALID_VALUE');

  // Métrica que ficou esperando nova tentativa também vence.
  await limparConfig(tenant, ['integration.analytics.drop_after_s']);
  const espera = await emitir('emitMetric', { name: 'leads.espera', value: 1 });
  await comTenant(tenant, (t) => sequelize.query("UPDATE integration.dispatches SET status = 'RETRY_WAIT', next_attempt_at = now() + interval '1 hour', created_at = now() - interval '400 seconds' WHERE id = :id", { replacements: { id: espera.dispatchId }, transaction: t }));
  await rodar();
  assert.equal((await ler(tenant, espera.dispatchId)).status, 'CANCELLED');
});
