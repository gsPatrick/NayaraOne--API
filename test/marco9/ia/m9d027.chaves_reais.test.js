'use strict';

// Marco 9, M9-D027 (reabertura, achado G-2 da auditoria de fechamento) — chaves de provider no formato REAL (Anthropic com hífens,
// OpenAI sk-proj, Google AIza, Groq, Hugging Face, xAI, Perplexity, OpenRouter) são mascaradas por toda a biblioteca de redaction e
// reconhecidas pelas guardas. As chaves abaixo são inventadas, só com o formato. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactText, redactForAi, containsSecretLike } = require('../../../src/shared/redaction');
const { redactForStorage } = require('../../../src/features/ai/security/piiRedactor');
const { containsSecret, maskSecrets } = require('../../../src/features/ai/guards/secretPatterns');
const { sanitizeSummary } = require('../../../src/features/ai/audit/auditSanitizer');

const CHAVES = Object.freeze({
  anthropic: 'sk-ant-api03-Xk9fQ2LmN7pR4tVwZ8bC1dE5gH6jK0aS3uY-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AAAA',
  openaiProjeto: 'sk-proj-aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL3nR6uX9bD2fG5iJ8kM1oP4rT7wA0eC3',
  openaiClassica: 'sk-aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL3nR6uX9bD2fG5iJ',
  openaiServico: 'sk-svcacct-aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL3nR6uX9bD2fG5iJ8kM1oP4',
  openrouter: 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  google: 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
  groq: 'gsk_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL3nR6uX9bD2fG5iJ8kM1',
  huggingface: 'hf_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL3nR6',
  xai: 'xai-aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL3nR6uX9bD2fG5iJ8kM1',
  perplexity: 'pplx-aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL3nR6uX9bD2fG5iJ8kM1',
});

test('m9d027_chave_de_provider_no_formato_real_e_mascarada_em_todos_os_perfis', () => {
  for (const [nome, chave] of Object.entries(CHAVES)) {
    const texto = `Minha chave é ${chave} e pronto.`;
    assert.ok(!redactText(texto).includes(chave.slice(0, 14)), `redactText ${nome}: ${redactText(texto)}`);
    assert.ok(!redactForAi(texto).includes(chave.slice(0, 14)), `redactForAi ${nome}`);
    assert.equal(redactForAi(texto), 'Minha chave é [REDIGIDO:token] e pronto.', nome);
    assert.ok(!redactForStorage(texto).includes(chave.slice(0, 14)), `redactForStorage ${nome}`);
    assert.ok(!maskSecrets(texto).includes(chave.slice(0, 14)), `maskSecrets ${nome}`);
    assert.ok(!sanitizeSummary(texto, 2000).includes(chave.slice(0, 14)), `sanitizeSummary ${nome}`);
  }
});

test('m9d027_guardas_reconhecem_a_chave_de_provider', () => {
  for (const [nome, chave] of Object.entries(CHAVES)) {
    assert.equal(containsSecret(`use ${chave}`), true, `containsSecret ${nome}`);
    assert.equal(containsSecret({ nota: chave }), true, `containsSecret em objeto ${nome}`);
    assert.equal(containsSecretLike(`use ${chave}`), true, `containsSecretLike ${nome}`);
  }
});

test('m9d027_chave_na_url_ou_no_json_tambem_some', () => {
  const chave = CHAVES.anthropic;
  assert.ok(!redactForAi(`curl -H "x-api-key: ${chave}" https://api.example.com`).includes(chave));
  assert.ok(!redactForAi(`https://x.example.com/v1?key=${CHAVES.google}&alt=json`).includes(CHAVES.google));
  assert.ok(!redactForAi(JSON.stringify({ chave })).includes(chave));
});

test('m9d027_texto_comum_com_sk_e_hifen_nao_e_tocado', () => {
  for (const t of ['risk-management-plan-2026', 'task-force-alpha-bravo-charlie', 'sk-curto', 'Disk-usage-report-monthly-summary-final', 'hf_curto', 'Pedido pplx-12 aprovado', 'AIza curto']) {
    assert.equal(redactForAi(t), t, t);
    assert.equal(containsSecret(t), false, t);
  }
});
