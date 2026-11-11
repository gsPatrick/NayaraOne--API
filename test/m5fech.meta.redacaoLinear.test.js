'use strict';

/**
 * Pentest automatizado do Marco 5 (11/11/2026): um texto livre de 1 MB aceito por uma rota (motivo, observação)
 * passava pela redação de logs/auditoria e travava a API por minutos — os padrões de e-mail e de senha em
 * string de conexão começavam a busca em toda posição de uma sequência longa (custo O(n²)). Agora a busca só
 * começa onde a sequência começa: o custo é linear e o que era redigido continua redigido. Sem banco.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/shared/redaction/patterns');
const R = require('../src/shared/redaction');

const MB = 1024 * 1024;

test('redação: 1 MB de texto sem dado sensível passa por todos os padrões em tempo linear (antes: minutos)', () => {
  for (const ch of ['x', '1', ' ', 'x.', 'a-', 'x@']) {
    const texto = ch.repeat(Math.floor(MB / ch.length));
    const t0 = Date.now();
    for (const nome of Object.keys(P.SOURCES)) texto.replace(P.rx(nome), '');
    R.redactText(texto);
    assert.ok(Date.now() - t0 < 5000, `"${ch}" x 1 MB levou ${Date.now() - t0} ms`);
  }
});

test('redação: e-mail e senha em string de conexão continuam redigidos (no começo, no meio e colados em texto)', () => {
  const saida = R.redactText('fulano@exemplo.com.br, texto postgres://usuario:segredo123@host/db e ciclano.silva+teste@empresa.com');
  assert.doesNotMatch(saida, /fulano@exemplo|segredo123|ciclano\.silva\+teste@/);
  assert.match(saida, /postgres:\/\/usuario:\[REDACTED\]@host/);
  assert.equal(P.rx('emailLoose', '').test('contato: a@b.c'), true);
  assert.equal(new RegExp(`^${P.SOURCES.emailSimple}$`).test('nome@dominio'), true);
});
