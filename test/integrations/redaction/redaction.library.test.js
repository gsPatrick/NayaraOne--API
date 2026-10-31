'use strict';

// Marco 9, M9-D246 — biblioteca única de redaction (src/shared/redaction): nome de chave, padrão de valor, PII, cartão (Luhn),
// classe SecretValue, e o logger real (pino) gravando já redigido. Não usa banco.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { redactDeep, redactText, describeForLog, REDACTED } = require('../../../src/shared/redaction');
const { SecretValue } = require('../../../src/features/integrations/secrets/SecretValue');

test('redaction_por_nome_de_chave_em_qualquer_profundidade', () => {
  const nomes = ['authorization', 'cookie', 'set-cookie', 'password', 'senha', 'secret', 'token', 'access_token', 'refresh_token',
    'api_key', 'apikey', 'client_secret', 'webhook_secret', 'private_key', 'x-signature', 'signature', 'card', 'cvv', 'pan'];
  for (const nome of nomes) {
    for (const variante of [nome, nome.toUpperCase(), nome.replace(/[-_]/g, '')]) {
      const saida = redactDeep({ a: { b: [{ c: { [variante]: 'VALOR-SENSIVEL' } }] }, ok: 'visivel' });
      assert.equal(saida.a.b[0].c[variante], REDACTED, `chave ${variante}`);
      assert.equal(saida.ok, 'visivel');
    }
  }
  const exemplo = redactDeep({ headers: { Authorization: 'Bearer abc.def.ghi' }, cpf: '123.456.789-09' });
  assert.deepEqual(exemplo, { headers: { Authorization: REDACTED }, cpf: '***.456.789-**' });
  assert.equal(redactDeep({ company: 'Nayara', panel: 'x', tokenCount: 3 }).company, 'Nayara', 'não redige por pedaço do nome');
  assert.equal(redactDeep({ panel: 'x' }).panel, 'x');
});

test('redaction_por_padrao_de_valor_jwt_bearer_pem', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJh';
  assert.equal(redactText(`erro com ${jwt} no meio`), `erro com ${REDACTED} no meio`);
  assert.equal(redactText('Authorization: Bearer abc.def.ghi'), `Authorization: ${REDACTED}`);
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END RSA PRIVATE KEY----- fim';
  assert.equal(redactText(`chave ${pem}`), `chave ${REDACTED} fim`);
  assert.equal(redactText('-----BEGIN PRIVATE KEY-----\nMIIEvQ'), REDACTED, 'PEM truncado também');
  assert.ok(!redactText('postgres://dono:SENHA-FORTE@host/db').includes('SENHA-FORTE'));
  assert.ok(!redactText('AKIAABCDEFGHIJKLMNOP e sk_live_abc123 e ghp_abcdefghijklmnopqrstuvwxyz0123').match(/AKIA|sk_live|ghp_/));
  assert.ok(!redactText('chamada api_key=SECRET-CANARY-7f3a&x=1').includes('SECRET-CANARY-7f3a'));
  assert.equal(redactText('sem segredo nenhum'), 'sem segredo nenhum');
});

test('redaction_cpf_cnpj_email_telefone_mascarados', () => {
  assert.equal(redactText('CPF 123.456.789-09 ok'), 'CPF ***.456.789-** ok');
  assert.equal(redactText('CPF 12345678909 ok'), 'CPF ***456789** ok');
  assert.equal(redactText('CPF 12345678900 inválido fica'), 'CPF 12345678900 inválido fica', 'sem dígito válido não é CPF');
  assert.equal(redactText('CNPJ 11.222.333/0001-81'), 'CNPJ **.***.***/0001-**');
  assert.equal(redactText('mail joao.silva@exemplo.com.br fim'), 'mail j***@exemplo.com.br fim');
  assert.equal(redactText('fone (11) 98765-4321'), 'fone (**) *****-**21');
  assert.equal(redactText('fone +55 11 98765-4321'), 'fone +** ** *****-**21');
  const profundo = redactDeep({ pessoa: { contatos: ['a@b.com', { fone: '(21) 3456-7890' }] } });
  assert.deepEqual(profundo, { pessoa: { contatos: ['a***@b.com', { fone: '(**) ****-**90' }] } });
  assert.equal(redactText('id 5be9aad1-1d7c-4a6e-9f3a-123456789012 e 2026-10-28T10:00:00.000Z'), 'id 5be9aad1-1d7c-4a6e-9f3a-123456789012 e 2026-10-28T10:00:00.000Z', 'uuid e data não são tocados');
  assert.equal(redactText('CPF 123.456.789-09 e e-mail a@b.com', { secretsOnly: true }), 'CPF 123.456.789-09 e e-mail a@b.com', 'secretsOnly não mexe em PII');
});

test('redaction_cartao_luhn', () => {
  assert.equal(redactText('cartao 4111 1111 1111 1111 fim'), `cartao ${REDACTED} fim`);
  assert.equal(redactText('cartao 4111-1111-1111-1111'), `cartao ${REDACTED}`);
  assert.equal(redactText('amex 378282246310005'), `amex ${REDACTED}`);
  assert.equal(redactText('numero 4111 1111 1111 1112 nao passa Luhn'), 'numero 4111 1111 1111 1112 nao passa Luhn');
  assert.equal(redactText('protocolo 1234567890123456789012'), 'protocolo 1234567890123456789012', 'mais de 19 dígitos não é cartão');
  assert.equal(redactDeep({ card: '4111111111111111', pan: 4111111111111111 }).pan, REDACTED);
});

test('redaction_classe_secretvalue_tojson', () => {
  const segredo = new SecretValue('SECRET-CANARY-7f3a');
  assert.equal(JSON.stringify({ s: segredo }), '{"s":"[REDACTED]"}');
  assert.deepEqual(redactDeep({ qualquerNome: segredo, lista: [segredo] }), { qualquerNome: REDACTED, lista: [REDACTED] });
  assert.equal(`${segredo}`, REDACTED);
  const erro = new Error('falhou com Bearer SECRET-CANARY-7f3a');
  const limpo = JSON.stringify(redactDeep({ erro, buffer: Buffer.from('SECRET-CANARY-7f3a') }));
  assert.ok(!limpo.includes('SECRET-CANARY-7f3a'), limpo);
  const ciclo = { a: 1 }; ciclo.self = ciclo;
  assert.equal(redactDeep(ciclo).self, '[Circular]');
});

test('log_real_do_pino_grava_redigido_mensagem_objeto_e_erro', () => {
  const codigo = `
    const l = require('./src/utils/logger');
    const { SecretValue } = require('./src/features/integrations/secrets/SecretValue');
    l.info({ headers: { Authorization: 'Bearer abc.def.ghi' }, cpf: '123.456.789-09', s: new SecretValue('SECRET-CANARY-7f3a'), card: '4111 1111 1111 1111' }, 'cpf 123.456.789-09 token=SECRET-CANARY-7f3a');
    l.error(new Error('falhou Bearer SECRET-CANARY-7f3a'));
    l.warn({ err: new Error('x api_key=SECRET-CANARY-7f3a') }, 'm');`;
  const r = spawnSync(process.execPath, ['-e', codigo], { cwd: path.join(__dirname, '..', '..', '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('SECRET-CANARY-7f3a') && !r.stdout.includes('abc.def.ghi') && !r.stdout.includes('4111'), r.stdout);
  const primeira = JSON.parse(r.stdout.split('\n')[0]);
  assert.equal(primeira.headers.Authorization, REDACTED);
  assert.equal(primeira.cpf, '***.456.789-**');
  assert.equal(primeira.msg, 'cpf ***.456.789-** token=[REDACTED]');
});

test('log_nunca_contem_corpo_bruto_de_webhook_descricao_so_hash_tamanho_e_tipo', () => {
  const corpo = '{"event":"paid","token":"SECRET-CANARY-7f3a"}';
  const d = describeForLog(corpo, 'payment.paid');
  assert.deepEqual(Object.keys(d).sort(), ['event_type', 'payload_hash', 'size']);
  assert.equal(d.size, Buffer.byteLength(corpo));
  assert.match(d.payload_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(d).includes('SECRET-CANARY-7f3a'));
  assert.equal(redactDeep({ rawBody: corpo, providerPayload: { a: 1 } }).rawBody, REDACTED);
  assert.equal(describeForLog(Buffer.from(corpo)).payload_hash, d.payload_hash);
});

test('redaction_palavra_de_credencial_seguida_de_valor_com_cara_de_segredo', () => {
  assert.equal(redactText('falha com token SECRET-CANARY-7f3a ok'), `falha com token ${REDACTED} ok`);
  assert.equal(redactText('o token expirado ontem'), 'o token expirado ontem', 'palavra comum depois de "token" fica');
});

test('redaction_validadores_de_email_e_cartao_moram_na_biblioteca', () => {
  const { isEmailFormat, containsCardNumber } = require('../../../src/shared/redaction');
  assert.equal(isEmailFormat('a@b.com'), true);
  assert.equal(isEmailFormat('a@b'), false, 'domínio sem ponto só passa no modo frouxo');
  assert.equal(isEmailFormat('a@b', { requireDot: false }), true);
  assert.equal(isEmailFormat('a b@c.com'), false);
  assert.equal(isEmailFormat(null), false);
  assert.equal(containsCardNumber('cartao 4111 1111 1111 1111 ok'), true);
  assert.equal(containsCardNumber('numero 4111 1111 1111 1112 nao passa'), false);
  assert.equal(containsCardNumber('cpf 529.982.247-25'), false, 'CPF válido não é cartão');
  assert.equal(containsCardNumber(undefined), false);
});
