'use strict';

// Marco 9, M9-D222 — os 10 cenários da suíte de contrato, executados para cada adapter com fixtures (messaging e signature, sandbox e alternativo), sem banco e sem rede.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
const contract = require('../../../src/features/integrations/contract');
const { SignatureSandboxAdapter } = require('../../../src/features/integrations/providers/signature/sandbox/signature-sandbox.adapter');
const { classifyFailure } = require('../../../src/features/integrations/contract/contract.runtime');
const { httpError } = require('../../../src/features/integrations/contract/contract.wire');

const relatorios = new Map();
before(async () => {
  registerBuiltInAdapters();
  for (const alvo of contract.listTargets()) relatorios.set(alvo.providerCode, await contract.runSuite(alvo));
});

/** Todo adapter coberto passou no cenário `id` (com pelo menos uma execução) e o detalhe de uma falha aparece na mensagem. */
function exigeCenario(id) {
  assert.ok(relatorios.size >= 4, 'os 4 adapters com fixtures foram executados');
  for (const [provider, rel] of relatorios) {
    const c = rel.scenarios.find((s) => s.id === id);
    assert.ok(c.executions > 0, `${provider}: o cenário ${id} não executou`);
    assert.deepEqual(c.failures, [], `${provider}: cenário ${id} (${c.name}) reprovado`);
    assert.equal(c.passed, c.executions);
  }
}

test('contrato_auth_valida_invalida_expirada', () => exigeCenario(1));
test('contrato_happy_path_todas_capabilities', () => {
  exigeCenario(2);
  for (const [provider, rel] of relatorios) {
    const c = rel.scenarios.find((s) => s.id === 2);
    assert.equal(c.executions, rel.capabilities.length, `${provider}: uma execução por capability`);
  }
});
test('contrato_timeout_classifica_por_opclass', () => exigeCenario(3));
test('contrato_4xx_validation', () => exigeCenario(4));
test('contrato_5xx_transient', () => exigeCenario(5));
test('contrato_rate_limit_retry_after', () => exigeCenario(6));
test('contrato_duplicate_request_um_recurso', () => exigeCenario(7));
test('contrato_resposta_malformada_sem_excecao', () => exigeCenario(8));
test('contrato_status_mapping_completo', () => exigeCenario(9));
test('contrato_health_check_nunca_lanca', () => exigeCenario(10));

test('contrato_5xx_dangerous_sem_idempotencia_vira_unknown', async () => {
  // Operação perigosa sem chave de idempotência: 5xx não repete às cegas (UNKNOWN); com a chave ou numa operação segura, é TRANSIENT (tabela única da M9-D216).
  const semChave = new (class extends SignatureSandboxAdapter { supportsIdempotency() { return false; } })(null);
  for (const status of [500, 502, 503, 504]) assert.equal(classifyFailure(semChave, httpError(status), 'createEnvelope').class, 'UNKNOWN', String(status));
  const comChave = new SignatureSandboxAdapter(null);
  assert.equal(classifyFailure(comChave, httpError(503), 'createEnvelope').class, 'TRANSIENT');
  assert.equal(classifyFailure(semChave, httpError(503), 'getEnvelope').class, 'TRANSIENT', 'operação segura repete');
  // O timeout do cliente numa operação perigosa é sempre UNKNOWN, com ou sem chave.
  const timeout = Object.assign(new Error('t'), { code: 'ETIMEDOUT' });
  assert.equal(classifyFailure(comChave, timeout, 'createEnvelope').class, 'UNKNOWN');
  // E a suíte inteira passa para o adapter sem idempotência, porque ele tem a consulta de reconciliação (o 5xx dá UNKNOWN, como deve).
  const Sem = class extends SignatureSandboxAdapter { supportsIdempotency() { return false; } };
  const rel = await contract.runSuite({ providerCode: 'signature-sandbox', domain: 'SIGNATURE', AdapterClass: Sem });
  assert.equal(rel.status, 'PASSED', JSON.stringify(rel.scenarios.map((s) => s.failures).flat().slice(0, 3)));
});
