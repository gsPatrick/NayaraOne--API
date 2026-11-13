'use strict';

// DI-M9R-28 (verificação m9-rodada8, observação do implementador): o safeLogger gravava FILES_ENCRYPTION_KEY e MFA_ENCRYPTION_KEY em claro
// quando o ambiente ia para o log (m9d028), porque a redação por nome não cobria chaves de cifra, mestras, de assinatura e strings de conexão.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactDeep, isSensitiveKey } = require('../../../src/shared/redaction');

const SEGREDO = 'SECRET-CANARY-7f3a-cifra';
const SENSIVEIS = ['FILES_ENCRYPTION_KEY', 'MFA_ENCRYPTION_KEY', 'SECRET_STORE_MASTER_KEY', 'encryptionKey', 'masterKey', 'signingKey',
  'WEBHOOK_HMAC_KEY', 'AWS_SECRET_KEY', 'DLP_TOKEN_KEY', 'DATABASE_URL', 'DATABASE_ADMIN_URL', 'connectionString', 'HOMO_ADMIN_MFA_CODE', 'HOMO_AUDITOR_A_MFA_CODE'];
const VISIVEIS = ['idempotencyKey', 'actionKey', 'sortKey', 'personKey', 'key', 'monkey', 'CLICKSIGN_BASE_URL', 'DEV_API_BASE_URL', 'SECRET_STORE_DRIVER'];

test('chaves de cifra, mestras, de assinatura e strings de conexão são segredo por nome', () => {
  for (const k of SENSIVEIS) assert.equal(isSensitiveKey(k), true, k);
});

test('chaves que não são segredo continuam visíveis', () => {
  for (const k of VISIVEIS) assert.equal(isSensitiveKey(k), false, k);
});

test('o ambiente redigido não traz o valor de nenhuma chave de cifra', () => {
  const env = Object.fromEntries(SENSIVEIS.map((k) => [k, SEGREDO]));
  env.idempotencyKey = 'idem-123';
  const saida = JSON.stringify(redactDeep({ env }));
  assert.equal(saida.includes(SEGREDO), false, saida);
  assert.match(saida, /idem-123/);
});
