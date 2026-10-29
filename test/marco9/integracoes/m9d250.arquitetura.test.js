'use strict';

// Marco 9, M9-D250 — arquitetura das ações do operador: rotas e permissões, consulta inócua só em operação sem efeito, parâmetros no dicionário e lidos, corpos validados.
// Não usa banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { gerar } = require('../../../scripts/gerarMatrizPermissoes');
const { PORTS } = require('../../../src/features/integrations/providers/ports');
const { OPERATION_POLICY } = require('../../../src/features/integrations/providers/ports/operationPolicy');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { ACTIONS_SETTINGS_SCHEMA } = require('../../../src/features/integrations/admin/actions/actions.settings');
const { parseRetryBody, parseTestBody, parseRotateBody } = require('../../../src/features/integrations/admin/actions/actions.body');
const { refusalReason } = require('../../../src/features/integrations/dispatch/dispatchStateMachine');

const RAIZ = path.join(__dirname, '..', '..', '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const ACOES = 'src/features/integrations/admin/actions';

test('rotas_das_acoes_com_a_permissao_do_livro', () => {
  const rotas = gerar();
  const acha = (metodo, caminho) => rotas.find((r) => r.method === metodo && r.path === caminho);
  assert.deepEqual(acha('POST', '/api/v1/admin/integrations/errors/:id/retry').permissions, ['integration:retry']);
  assert.deepEqual(acha('POST', '/api/v1/admin/integrations/:provider/test-connection').permissions, ['integration:test']);
  assert.deepEqual(acha('POST', '/api/v1/admin/integrations/:provider/rotate-secret').permissions, ['integration:manage']);
});

test('consulta_inocua_so_em_operacao_segura_sem_campo_obrigatorio', () => {
  const marcadas = [];
  Object.entries(PORTS).forEach(([dominio, Port]) => Object.entries(Port.operations).forEach(([nome, def]) => {
    if (def.safeProbe) marcadas.push(`${dominio}.${nome}`);
    if (def.safeProbe) {
      assert.equal(def.opClass, 'SAFE', `${dominio}.${nome}`);
      assert.deepEqual(def.inputSchema.required, [], `${dominio}.${nome}: pedido vazio basta`);
      assert.ok(/^(get|list|query|head|find)/.test(nome), `${dominio}.${nome}: só consulta`);
    }
    if (def.opClass === 'DANGEROUS') assert.ok(!def.safeProbe, `${dominio}.${nome}: perigosa nunca é consulta de teste`);
  }));
  assert.deepEqual(marcadas.sort(), ['ANALYTICS.queryHealth', 'IDENTITY.listJwks']);
  assert.ok(Object.values(OPERATION_POLICY).every((ops) => Object.values(ops).every((d) => !d.safeProbe || d.opClass === 'SAFE')));
});

test('o_teste_de_conexao_nao_importa_nenhum_envio', () => {
  const codigo = ['testConnection.probe.js', 'testConnection.service.js'].map((f) => ler(`${ACOES}/${f}`)).join('\n');
  assert.ok(!/dispatch\.enqueue|createDispatch|submitPayment|sendText|sendEmail|publishPost/.test(codigo), 'o teste só chama healthCheck e a consulta inócua');
  assert.match(codigo, /runHealthCheck/);
  assert.match(codigo, /safeProbe/);
});

test('parametros_da_acao_estao_no_dicionario_e_sao_lidos', () => {
  const chaves = Object.keys(ACTIONS_SETTINGS_SCHEMA);
  assert.deepEqual(chaves.sort(), ['integration.admin.mfa_on_secret_rotation', 'integration.admin.test_connection_timeout_ms', 'integration.retry.human_extra_attempts']);
  const leitor = ler(`${ACOES}/actions.params.js`);
  [...chaves, 'integration.admin.mfa_on_prod_test_connection'].forEach((chave) => {
    assert.ok(SETTINGS_SCHEMA[chave], `${chave} no dicionário`);
    assert.ok(leitor.includes(`'${chave}'`), `${chave} é lido por actions.params.js`);
  });
  assert.match(ler('src/features/integrations/dispatch/dispatch.transition.js'), /opts\.extraAttempts/, 'o valor lido chega à tentativa extra do envio');
  assert.match(ler(`${ACOES}/retry.webhook.js`), /humanExtraAttempts/);
});

test('so_o_retry_humano_sai_da_fila_morta_e_do_failed', () => {
  assert.ok(refusalReason('DEAD_LETTER', 'RETRY_WAIT', {}), 'sem o retry humano a máquina recusa');
  assert.equal(refusalReason('DEAD_LETTER', 'RETRY_WAIT', { humanRetry: true }), null);
  assert.ok(refusalReason('FAILED', 'RETRY_WAIT', {}));
  const inbox = ler('src/features/integrations/inbox/inbox.constants.js');
  assert.match(inbox, /DEAD_LETTER: Object\.freeze\(\[\]\)/, 'DEAD_LETTER segue final na tabela do worker; só o requeue humano sai dela');
  assert.match(ler('src/features/integrations/inbox/inbox.requeue.js'), /retry humano/i);
});

test('corpos_validados', () => {
  const erro = (fn, code) => assert.throws(fn, (e) => e.code === code, code);
  erro(() => parseRetryBody({}), 'INTEGRATION_RETRY_REASON_REQUIRED');
  erro(() => parseRetryBody({ reason: '  ab ' }), 'INTEGRATION_RETRY_REASON_REQUIRED');
  erro(() => parseRetryBody({ reason: 'x'.repeat(501) }), 'INTEGRATION_RETRY_REASON_REQUIRED');
  erro(() => parseRetryBody(null), 'INTEGRATION_RETRY_REASON_REQUIRED');
  erro(() => parseRetryBody({ reason: 'abc', confirmDangerous: 1 }), 'VALIDATION_ERROR');
  assert.deepEqual(parseRetryBody({ reason: ' abc ' }), { reason: 'abc', confirmDangerous: false });
  assert.deepEqual(parseRetryBody({ reason: 'abc', confirmDangerous: true }), { reason: 'abc', confirmDangerous: true });
  erro(() => parseTestBody({}), 'VALIDATION_ERROR');
  erro(() => parseTestBody({ environment: 'SANDBOX', connectionId: 'não-é-uuid' }), 'VALIDATION_ERROR');
  assert.deepEqual(parseTestBody({ environment: 'PRODUCTION' }), { environment: 'PRODUCTION', connectionId: null });
  erro(() => parseRotateBody({ environment: 'SANDBOX' }), 'VALIDATION_ERROR');
  erro(() => parseRotateBody({ environment: 'SANDBOX', generate: true, newSecretRef: 'a/b/c/d/e/f' }), 'VALIDATION_ERROR');
  assert.equal(parseRotateBody({ environment: 'SANDBOX', generate: true }).generate, true);
  assert.equal(parseRotateBody({ environment: 'HOMOLOG', newSecretRef: ' company/x/y/z ' }).newSecretRef, 'company/x/y/z');
});
