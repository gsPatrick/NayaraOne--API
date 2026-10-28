'use strict';

// Marco 9, M9-D027 — redactor do perfil `ai` (sem banco): tipos, falsos positivos, segredos e re-hidratação só em memória.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { createPiiRedactor, redactForStorage, redactDeepForStorage, redactForClassification, REDACTION_TYPES } = require('../../../src/features/ai/security/piiRedactor');
const { SOURCES, PLACEHOLDER_TYPES } = require('../../../src/shared/redaction');

test('m9d027_cpf_cnpj_telefone_email_redigidos', () => {
  assert.equal(redactForStorage('CPF 123.456.789-09, tel (11) 91234-5678'), 'CPF [REDIGIDO:cpf], tel [REDIGIDO:telefone]');
  assert.equal(redactForStorage('CPF 12345678909'), 'CPF [REDIGIDO:cpf]');
  assert.equal(redactForStorage('CNPJ 11.222.333/0001-81 e 11222333000181'), 'CNPJ [REDIGIDO:cnpj] e [REDIGIDO:cnpj]');
  assert.equal(redactForStorage('fale com maria@exemplo.com.br'), 'fale com [REDIGIDO:email]');
  assert.equal(redactForStorage('RG 12.345.678-9'), 'RG [REDIGIDO:rg]');
  assert.equal(redactForStorage('cartão 4111 1111 1111 1111'), 'cartão [REDIGIDO:cartao]');
  assert.equal(redactForStorage('Ag. 1234 conta corrente 123456-7'), 'Ag. [REDIGIDO:agencia] conta corrente [REDIGIDO:conta]');
  assert.equal(redactForStorage('chave pix: 3f9a8b7c-1111-2222-3333-444455556666'), 'chave pix: [REDIGIDO:pix]');
  assert.equal(redactForStorage('boleto 34191.79001 01043.510047 91020.150008 5 91070026000123'), 'boleto [REDIGIDO:boleto]');
  assert.equal(redactForStorage('34191790010104351004791020150008591070026000123'), '[REDIGIDO:boleto]');
  assert.equal(redactForStorage('Rua das Flores, 123 - Centro, 01310-100'), '[REDIGIDO:endereco], [REDIGIDO:cep]');
  assert.equal(redactForStorage('CEP: 01310100'), 'CEP: [REDIGIDO:cep]');
  assert.equal(redactForStorage('sem dado pessoal aqui: parcela 3 de 12, valor 1.250,00'), 'sem dado pessoal aqui: parcela 3 de 12, valor 1.250,00');
});

test('m9d027_cpf_invalido_nao_e_mascarado', () => {
  assert.equal(redactForStorage('Número 123.456.789-00 comum'), 'Número 123.456.789-00 comum');
  assert.equal(redactForStorage('protocolo 12345678900'), 'protocolo 12345678900');
  assert.equal(redactForStorage('cnpj falso 11.222.333/0001-00'), 'cnpj falso 11.222.333/0001-00');
  assert.equal(redactForStorage('número 4111 1111 1111 1112'), 'número 4111 1111 1111 1112', 'Luhn inválido não é cartão');
  assert.equal(redactForStorage('pix recebido ontem'), 'pix recebido ontem', 'a palavra pix sem chave não mascara');
  assert.equal(redactForStorage('o valor de 2026'), 'o valor de 2026');
});

test('m9d027_segredos_e_tokens_redigidos', () => {
  // montados em partes: a varredura de segredo do CI não pode achar credencial (nem de mentira) em arquivo versionado
  const jwt = ['ey', 'JhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjMifQ', '.c2lnbmF0dXJh'].join('');
  const bearer = ['Bea', 'rer ', 'abcdefghij1234567890'].join('');
  const aws = ['AK', 'IAABCDEFGHIJKLMNOP'].join('');
  const conexao = ['post', 'gres://dono:', 'SENHA-REAL-123', '@db:5432/app'].join('');
  assert.equal(redactForStorage('senha: abc12345 fim'), 'senha: [REDIGIDO:senha] fim');
  assert.equal(redactForStorage(`Authorization: ${bearer}`), 'Authorization: [REDIGIDO:token]');
  assert.equal(redactForStorage(`jwt ${jwt}`), 'jwt [REDIGIDO:token]');
  assert.equal(redactForStorage(`chave ${aws}`), 'chave [REDIGIDO:token]');
  assert.equal(redactForStorage('sk-abcdefghijklmn1234'), '[REDIGIDO:token]');
  assert.equal(redactForStorage(conexao), conexao.replace('SENHA-REAL-123', '[REDIGIDO:senha]'));
  assert.equal(redactForStorage('api_key=abc123def456'), 'api_key=[REDIGIDO:token]');
  const profundo = redactDeepForStorage({ nome: 'x', password: 'qualquer', lista: [{ cpf: '123.456.789-09', n: 12345678909 }], token: null });
  assert.deepEqual(profundo, { nome: 'x', password: '[REDIGIDO:segredo]', lista: [{ cpf: '[REDIGIDO:cpf]', n: '[REDIGIDO:cpf]' }], token: null });
});

test('m9d027_rehidratacao_so_no_retorno_ao_usuario', () => {
  const redactor = createPiiRedactor();
  const enviado = redactor.text('Cliente com CPF 123.456.789-09 e outro CPF 111.444.777-00 e 529.982.247-25, senha: abc12345');
  assert.equal(enviado, 'Cliente com CPF [REDIGIDO:cpf] e outro CPF 111.444.777-00 e [REDIGIDO:cpf#2], senha: [REDIGIDO:senha]');
  assert.ok(!enviado.includes('123.456.789-09'));
  // o mesmo valor reaparece com o mesmo placeholder
  assert.equal(redactor.text('de novo 123.456.789-09'), 'de novo [REDIGIDO:cpf]');
  // o texto devolvido ao usuário volta ao valor; o segredo não tem volta
  const resposta = redactor.rehydrate('O cliente [REDIGIDO:cpf] tem dívida; [REDIGIDO:cpf#2] também. [REDIGIDO:senha]');
  assert.equal(resposta, 'O cliente 123.456.789-09 tem dívida; 529.982.247-25 também. [REDIGIDO:senha]');
  assert.equal(redactor.rehydrate('[REDIGIDO:cpf#9]'), '[REDIGIDO:cpf#9]', 'placeholder desconhecido fica como está');
  // o mapa nunca é serializado, logado nem inspecionado
  assert.ok(!JSON.stringify(redactor.map).includes('123.456.789-09'));
  assert.ok(!util.inspect(redactor.map, { showHidden: true, depth: 5 }).includes('123.456.789-09'));
  assert.ok(!JSON.stringify({ r: redactor }).includes('123.456.789-09'));
  // run novo, mapa novo: nada é re-hidratado a partir de outro run
  assert.equal(createPiiRedactor().rehydrate('[REDIGIDO:cpf]'), '[REDIGIDO:cpf]');
});

test('m9d027_redactor_usa_a_biblioteca_unica_sem_regex_de_deteccao_propria', () => {
  const pasta = path.join(__dirname, '..', '..', '..', 'src', 'features', 'ai', 'security');
  for (const arquivo of fs.readdirSync(pasta).filter((f) => f.endsWith('.js'))) {
    const codigo = fs.readFileSync(path.join(pasta, arquivo), 'utf8');
    assert.ok(!/luhn|AKIA|eyJ|BEGIN [A-Z ]*PRIVATE/i.test(codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), `${arquivo} tem detecção própria`);
  }
  assert.match(fs.readFileSync(path.join(pasta, 'piiRedactor.js'), 'utf8'), /shared\/redaction/);
});

test('m9d027_catalogo_de_tipos_aponta_para_regras_da_biblioteca_unica', () => {
  const catalogo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'features', 'ai', 'security', 'piiTypes.json'), 'utf8'));
  assert.deepEqual([...REDACTION_TYPES].sort(), [...PLACEHOLDER_TYPES].sort(), 'todo tipo do catálogo existe no perfil ai e vice-versa');
  for (const { tipo, fonte } of catalogo.tipos) {
    for (const regra of fonte.filter((f) => !f.includes(' '))) assert.ok(SOURCES[regra], `${tipo}: a regra ${regra} não existe na biblioteca`);
  }
  assert.ok(!JSON.stringify(catalogo).includes('\\d'), 'o catálogo não carrega expressão regular');
});

test('m9d027_restricted_nunca_vira_trecho_gravado', () => {
  assert.equal(redactForClassification('contrato com CPF 123.456.789-09', 'RESTRICTED'), '[REDIGIDO:restrito]');
  assert.equal(redactForClassification('qualquer', 'SECRETA'), '[REDIGIDO:restrito]', 'classe desconhecida falha fechada');
  assert.equal(redactForClassification('contrato com CPF 123.456.789-09', 'CONFIDENTIAL'), 'contrato com CPF [REDIGIDO:cpf]');
  assert.equal(redactForClassification('texto público', 'PUBLIC'), 'texto público');
  assert.equal(redactForClassification(null, 'RESTRICTED'), null);
});
