'use strict';

// M9-D701 (reabertura L-5) — a chave do endereço assinado vem SÓ de JWT_ACCESS_SECRET: sem ela, falha explícita (nunca chave aleatória do processo) e o mesmo segredo
// assina e verifica em qualquer instância. Teste puro, sem banco.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { signDownloadUrl, verifyDownloadUrl } = require('../../../src/features/analytics/exports/export.url');

const saved = process.env.JWT_ACCESS_SECRET;
afterEach(() => { if (saved === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = saved; });

const NOW = new Date('2026-10-29T15:00:00Z');
const input = { jobId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', now: NOW, urlMinutes: 5, fileExpiresAt: new Date('2026-10-30T15:00:00Z') };
const parts = (url) => Object.fromEntries(new URL(url, 'http://x').searchParams);

test('m9d701 sem JWT_ACCESS_SECRET assinar e verificar o endereço falha de forma explícita, sem chave aleatória', () => {
  delete process.env.JWT_ACCESS_SECRET;
  assert.throws(() => signDownloadUrl(input), (err) => err.statusCode === 500 && /JWT_ACCESS_SECRET/.test(err.message));
  assert.throws(() => verifyDownloadUrl({ jobId: input.jobId, userId: input.userId, exp: '1793372400', sig: 'a'.repeat(64), now: NOW }), /JWT_ACCESS_SECRET/);
});

test('m9d701 o mesmo segredo assina numa instância e verifica em outra; segredo diferente recusa o endereço', () => {
  process.env.JWT_ACCESS_SECRET = 'segredo-de-teste-instancia-a';
  const { url } = signDownloadUrl(input);
  const { exp, sig } = parts(url);
  assert.doesNotThrow(() => verifyDownloadUrl({ jobId: input.jobId, userId: input.userId, exp, sig, now: NOW }));
  assert.equal(signDownloadUrl(input).url, url, 'determinística: nenhuma chave aleatória por processo');
  process.env.JWT_ACCESS_SECRET = 'segredo-de-teste-instancia-b';
  assert.throws(() => verifyDownloadUrl({ jobId: input.jobId, userId: input.userId, exp, sig, now: NOW }), (err) => err.code === 'ANALYTICS_EXPORT_LINK_INVALID');
});
