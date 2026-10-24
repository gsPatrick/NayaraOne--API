'use strict';

// Conferência ao vivo do Marco 4 (20/10/2026): F-01 (variável de ambiente ausente não vaza para a
// tela) e A1/F-09 (extrato: valor inválido, vírgula decimal, aspas, data de dia).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const AppError = require('../src/utils/AppError');
const errorHandler = require('../src/middlewares/errorHandler');

function run(err) {
  let out;
  const res = { status(c) { this.statusCode = c; return this; }, json(b) { out = { status: this.statusCode, body: b }; return this; } };
  errorHandler(err, { correlationId: 't', method: 'POST', originalUrl: '/x' }, res, () => {});
  return out;
}

test('F-01: variável de ambiente ausente vira mensagem genérica em português, 503, sem o nome da variável', () => {
  for (const [code, name] of [['FILES_CRYPTO_CONFIG_MISSING', 'FILES_ENCRYPTION_KEY'], ['MFA_CRYPTO_CONFIG_MISSING', 'MFA_ENCRYPTION_KEY'], ['JWT_CONFIG_MISSING', 'JWT_ACCESS_SECRET'], ['PII_HASH_CONFIG_MISSING', 'PII_HASH_SECRET']]) {
    const r = run(AppError.internal(`Variável de ambiente obrigatória ausente: ${name}.`, code));
    assert.equal(r.status, 503);
    assert.ok(!JSON.stringify(r.body).includes(name), `a resposta não pode conter ${name}`);
    assert.match(r.body.error.message, /Avise o administrador/);
  }
  const files = run(AppError.internal('Variável de ambiente obrigatória ausente: FILES_ENCRYPTION_KEY.', 'FILES_CRYPTO_CONFIG_MISSING'));
  assert.equal(files.body.error.code, 'FILES_STORAGE_NOT_CONFIGURED');
  assert.equal(files.body.error.message, 'O armazenamento de arquivos não está configurado neste ambiente. Avise o administrador.');
});

test('F-01 (controle): erro operacional comum continua com a própria mensagem e código', () => {
  const r = run(AppError.conflict('Já existe.', 'ALGUM_CODIGO'));
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ALGUM_CODIGO');
});
