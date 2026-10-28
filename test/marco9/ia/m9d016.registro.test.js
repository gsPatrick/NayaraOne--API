'use strict';

// M9-D016 — ToolRegistry: o servidor recusa no boot a definição incompleta ou insegura (AI-007) e expõe as tools iniciais.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry } = require('../../../src/features/ai/tools');
const { PERMISSION_CODES, defValida, defEscrita } = require('../_helpers/aiToolDefs');

const novo = () => new ToolRegistry({ permissionCodes: PERMISSION_CODES });
const CAMPOS = ['name', 'version', 'description', 'permissionCode', 'riskLevel', 'category', 'domain', 'inputSchema', 'outputSchema', 'requiresHumanApproval', 'idempotent', 'execute'];

function recusa(fn, mensagem) {
  const err = (() => { try { fn(); return null; } catch (e) { return e; } })();
  assert.ok(err, 'deveria recusar o registro');
  assert.equal(err.code, 'AI_TOOL_DEFINITION_INVALID');
  assert.equal(err.statusCode, 500);
  if (mensagem) assert.match(err.message, mensagem);
  return err;
}

test('m9d016_registro_sem_campos_obrigatorios_falha_no_boot', () => {
  assert.doesNotThrow(() => novo().register(defValida()));
  for (const campo of CAMPOS) {
    const def = defValida();
    delete def[campo];
    const err = recusa(() => novo().register(def));
    assert.equal(err.details.field, campo, `campo ${campo}`);
  }
  recusa(() => novo().register(defValida({ execute: 'não é função' })));
  recusa(() => novo().register(defValida({ riskLevel: 'ALTISSIMO' })));
  recusa(() => novo().register(defValida({ category: 'DELETE' })));
  recusa(() => novo().register(defValida({ domain: 'QUALQUER' })));
  recusa(() => novo().register(defValida({ inputSchema: { type: 'string' } })));
  recusa(() => novo().register(defValida({ outputSchema: null })));
  recusa(() => novo().register(defValida({ version: 0 })));
  recusa(() => novo().register(defValida({ requiresHumanApproval: 'sim' })));
  recusa(() => novo().register(null));
  const reg = novo();
  reg.register(defValida());
  recusa(() => reg.register(defValida()), /já registrada/i);
});

test('m9d016_permission_code_inexistente_falha_no_boot', () => {
  const err = recusa(() => novo().register(defValida({ permissionCode: 'inventado:tudo' })), /permiss/i);
  assert.equal(err.details.field, 'permissionCode');
  // Sem o catálogo de permissões nenhuma tool é aceita (falha fechada).
  recusa(() => new ToolRegistry({}).register(defValida()));
  recusa(() => new ToolRegistry().register(defValida()));
  assert.throws(() => new ToolRegistry({ permissionCodes: 5 }), { code: 'AI_TOOL_DEFINITION_INVALID' });
  // O wildcard nunca é permissão válida.
  recusa(() => novo().register(defValida({ permissionCode: '*' })));
});

test('m9d016_high_sem_aprovacao_falha_no_boot', () => {
  for (const riskLevel of ['HIGH', 'CRITICAL']) {
    recusa(() => novo().register(defValida({ riskLevel, requiresHumanApproval: false })), /AI-007/);
    assert.doesNotThrow(() => novo().register(defValida({ riskLevel, requiresHumanApproval: true })));
  }
  // Exemplo do livro: finance.proposePayment com requiresHumanApproval=false derruba o boot.
  recusa(() => novo().register(defEscrita('FINANCIAL', 'CRITICAL', false, { name: 'finance.proposePayment', permissionCode: 'finance:create' })), /AI-007/);
});

test('m9d016_write_tool_de_dominio_sensivel_sem_aprovacao_falha_no_boot', () => {
  for (const domain of ['FINANCIAL', 'LEGAL', 'BANKING', 'PERMISSION', 'PUBLICATION']) {
    for (const riskLevel of ['LOW', 'MEDIUM']) {
      recusa(() => novo().register(defEscrita(domain, riskLevel, false)), /Tool de escrita em domínio sensível exige aprovação humana/);
      assert.doesNotThrow(() => novo().register(defEscrita(domain, riskLevel, true)));
    }
  }
  assert.doesNotThrow(() => novo().register(defEscrita('OTHER', 'LOW', false)), 'escrita fora de domínio sensível, baixo risco, não exige aprovação');
  assert.doesNotThrow(() => novo().register(defValida({ name: 'teste.lerFinanceiro', domain: 'FINANCIAL' })), 'leitura em domínio sensível não é escrita');
});

test('m9d016_definicao_registrada_e_imutavel_e_versionada', () => {
  const reg = novo();
  const def = defValida();
  reg.register(def);
  const guardada = reg.get('teste.lerAlgo');
  assert.ok(Object.isFrozen(guardada));
  assert.ok(Object.isFrozen(guardada.inputSchema));
  def.permissionCode = 'ai:admin';
  assert.equal(reg.get('teste.lerAlgo').permissionCode, 'ai:use', 'mudar o objeto original não muda o registro');
  assert.throws(() => { guardada.riskLevel = 'LOW'; }, TypeError);
  reg.register(defValida({ version: 2 }));
  assert.equal(reg.get('teste.lerAlgo').version, 2, 'sem versão pedida vale a mais nova');
  assert.equal(reg.get('teste.lerAlgo', 1).version, 1);
  assert.equal(reg.get('nao.existe'), undefined);
});
