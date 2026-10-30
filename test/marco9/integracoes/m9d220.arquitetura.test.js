'use strict';

// Marco 9, M9-D220 — teste de arquitetura: nenhum módulo de negócio chama o fornecedor por conta própria. HTTP externo só nos adapters e no cliente HTTP único; o domínio só enfileira
// (dispatchService.enqueue) dentro da própria transação. A varredura geral de fronteiras é da M9-D257; esta cobre a regra "sem chamada de rede em transação de domínio".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', '..', 'src', 'features');
const HTTP = /require\(['"](axios|node-fetch|undici|https?|node:https?)['"]\)|\bIntegrationHttpClient\b|\bresilientFetch\b|(^|[^.\w])fetch\(/;
// Fora da varredura: o módulo de integrações inteiro (adapters, cliente HTTP, cofre), os modelos de IA e os adapters legados que cada módulo ainda mantém atrás do port (migram na demanda deles).
const FORA = [/^integrations\//, /^ai\/providers\//, /\/adapters\//];
// Exceções conhecidas e justificadas: teste de status de fornecedor da tela de configurações (somente leitura, sem dado de domínio).
const EXCECOES = new Set(['settings/settings.service.js']);

function arquivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? arquivos(path.join(dir, d.name)) : (d.name.endsWith('.js') ? [path.join(dir, d.name)] : [])));
}
const semComentario = (texto) => texto.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('dominio_sem_chamada_http_em_transacao', () => {
  const achados = arquivos(SRC).map((f) => path.relative(SRC, f)).filter((rel) => !FORA.some((r) => r.test(rel)) && !EXCECOES.has(rel))
    .filter((rel) => HTTP.test(semComentario(fs.readFileSync(path.join(SRC, rel), 'utf8'))));
  assert.deepEqual(achados, [], 'módulo de negócio chamando o fornecedor direto; deve enfileirar pelo Dispatch Service');
  // O enqueue nunca chama o fornecedor: não importa o adapter nem o invoke.
  const enqueue = fs.readdirSync(path.join(SRC, 'integrations/dispatch/enqueue')).map((n) => fs.readFileSync(path.join(SRC, 'integrations/dispatch/enqueue', n), 'utf8')).join('\n');
  assert.ok(!/invoke\(/.test(semComentario(enqueue)), 'o enqueue não invoca operação do fornecedor');
  // A varredura enxerga a violação quando ela existe.
  assert.equal(HTTP.test("const r = await fetch('https://x');"), true);
  assert.equal(HTTP.test("const { IntegrationHttpClient } = require('../integrations');"), true);
  assert.equal(HTTP.test('const x = obj.fetch(1);'), false);
});
