'use strict';

// M9-D920 — o setup dos testes HTTP não perde a API por colisão de porta: o fechamento do bloco F falhou de forma intermitente no GitHub com "fetch failed / ECONNREFUSED" no hook `before`
// do m9d920.impressao (porta sorteada em 30000-49999, faixa efêmera do Linux; o listen falhava sem ninguém ver e a pausa fixa de 400 ms só adiava o erro).
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aguardarOuvindo } = require('../_helpers/m9d806Http');
const { portaLivre } = require('../_helpers/portaLivre');

const DIR = __dirname;

test('m9d920 nenhum teste do Governança sorteia a porta da API na faixa efêmera', () => {
  const culpados = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'))
    .filter((f) => /PORT\s*=.*Math\.random\(\)/.test(fs.readFileSync(path.join(DIR, f), 'utf8')));
  assert.deepEqual(culpados, [], 'use portaLivre() (o SO escolhe), não um número sorteado');
});

test('m9d920 os testes HTTP da impressão, do download, do lote e do anexo pedem a porta ao SO', () => {
  for (const n of ['impressao', 'download', 'lote', 'anexo']) {
    assert.match(fs.readFileSync(path.join(DIR, `m9d920.${n}.http.test.js`), 'utf8'), /process\.env\.PORT\s*=.*portaLivre\(\)/, n);
  }
});

test('m9d920 aguardarOuvindo: porta ocupada falha NA HORA e diz a porta e o código (antes virava ECONNREFUSED no login)', async () => {
  const ocupante = http.createServer();
  await new Promise((resolve) => ocupante.listen(0, '127.0.0.1', resolve));
  const { port } = ocupante.address();
  const segundo = http.createServer();
  segundo.listen(port, '127.0.0.1');
  try {
    await assert.rejects(() => aguardarOuvindo(segundo, port, 5000), (e) => e.message.includes(String(port)) && e.message.includes('EADDRINUSE'));
  } finally { await new Promise((resolve) => ocupante.close(resolve)); }
});

test('m9d920 aguardarOuvindo: espera o listen mesmo quando ele demora (sem pausa fixa) e resolve na hora se já ouve', async () => {
  const porta = Number(portaLivre());
  const srv = http.createServer();
  const espera = aguardarOuvindo(srv, porta, 5000);
  setTimeout(() => srv.listen(porta, '127.0.0.1'), 700); // mais que os 400 ms da pausa antiga
  await espera;
  assert.equal(srv.listening, true);
  await aguardarOuvindo(srv, porta, 50);
  await new Promise((resolve) => srv.close(resolve));
});

test('m9d920 aguardarOuvindo: servidor que nunca ouve estoura o prazo com mensagem clara', async () => {
  await assert.rejects(() => aguardarOuvindo(http.createServer(), 1234, 100), /não passou a ouvir na porta 1234 em 100 ms/);
});
