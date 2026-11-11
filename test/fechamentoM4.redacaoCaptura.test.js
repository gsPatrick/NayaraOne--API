'use strict';

// Captura do fechamento do Marco 4 (scripts/fechamento-m4): o token ASSINADO da confirmação de nível 3 (impactToken, duas partes
// `base64url(json).assinatura`) saía sem redação em 12 evidências (verificação independente do Marco 4, partes 1 e 2, 11/11/2026).
// Sem banco: só a função de redação usada pelo runner da captura e a varredura final da saída.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Token no MESMO formato do impactToken (payload JSON em base64url + HMAC), montado aqui com dados fictícios.
function tokenFicticio() {
  const payload = Buffer.from(JSON.stringify({ k: 'finance.entry.reverse', r: crypto.randomUUID(), c: crypto.randomUUID(), u: crypto.randomUUID(), h: 'f'.repeat(64), e: Date.now() + 600000 })).toString('base64url');
  const assinatura = crypto.createHmac('sha256', 'segredo-ficticio-do-teste').update(payload).digest('base64url');
  return `${payload}.${assinatura}`;
}

function passoComToken(tok) {
  return {
    id: 'L04',
    rota: `/finance/entries/x/impact?confirmationToken=${tok}`,
    corpoEnviado: { reason: 'estorno', confirmation: { typedCode: 'ABC123', impactToken: tok, understood: true } },
    cabecalhosEnviados: { 'x-impact-token': tok },
    corpo: { success: true, data: { actionKey: 'finance.entry.reverse', impactToken: tok, level: 3, nota: `token no texto: ${tok}` } },
  };
}

test('captura M4: o impactToken assinado (corpo, cabeçalho, rota e texto) sai redigido pelo runner da captura', () => {
  const { redigirFundo } = require('../scripts/fechamento-m4/runner');
  const tok = tokenFicticio();
  const saida = JSON.stringify(redigirFundo(passoComToken(tok)));
  assert.ok(!saida.includes(tok), 'o token assinado continua na saída redigida');
  assert.ok(!saida.includes(tok.split('.')[0]), 'o payload do token (base64) continua na saída redigida');
  const red = redigirFundo(passoComToken(tok));
  assert.equal(red.corpo.data.impactToken, '[REDACTED]');
  assert.equal(red.corpoEnviado.confirmation.impactToken, '[REDACTED]');
  assert.equal(red.cabecalhosEnviados['x-impact-token'], '[REDACTED]');
  // O código digitado da confirmação não é segredo: aparece na tela para a pessoa digitar.
  assert.equal(red.corpoEnviado.confirmation.typedCode, 'ABC123');
  assert.equal(red.corpo.data.actionKey, 'finance.entry.reverse');
});

test('captura M4: a varredura final acha token assinado, inclusive no base64 decodificado, e não acha nada depois da redação', () => {
  const { acharSegredos, redigirFundo } = require('../scripts/fechamento-m4/redacao');
  const tok = tokenFicticio();
  const cru = passoComToken(tok);
  const achados = acharSegredos(cru);
  assert.ok(achados.some((a) => a.caminho === '$.corpo.data.impactToken'), JSON.stringify(achados));
  // Só o payload (base64 sem o "eyJ" do token inteiro em outro formato): a decodificação acha o conteúdo do token.
  const soPayloadPadrao = { nota: Buffer.from(Buffer.from(tok.split('.')[0], 'base64url').toString('utf8')).toString('base64') };
  assert.ok(acharSegredos(soPayloadPadrao).length > 0, 'payload do token em base64 padrão não foi achado');
  assert.deepEqual(acharSegredos(redigirFundo(cru)), []);
  // Texto comum (ids, hashes, descrições) não é acusado.
  assert.deepEqual(acharSegredos({ id: crypto.randomUUID(), fingerprint: 'a'.repeat(64), descricao: 'Estorno de teste' }), []);
});
