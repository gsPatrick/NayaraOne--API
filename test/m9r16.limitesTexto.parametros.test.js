'use strict';

// DI-M9R-16 (verificação do Marco 9, rodada 6): o tamanho máximo do texto livre das mensagens é parâmetro da empresa, com o teto do canal. Cada chave está no
// dicionário de Configurações (a API valida a faixa), no catálogo Maturacao/demandas/parametros.csv, na tela do Front e é lida por código de produção.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SETTINGS_SCHEMA } = require('../src/features/settings/settings.service');
const whatsapp = require('../src/features/crm/messaging/whatsapp.params');
const mensageria = require('../src/features/crm/messaging/messaging.params');
const { assertSendTextLimits } = require('../src/features/crm/messaging/messaging.textLimits');

const RAIZ = path.join(__dirname, '..');
const CHAVES = {
  'integration.whatsapp.max_text_chars': { min: 1, max: 4096, padrao: whatsapp.PADROES.maxTextChars, esperado: 4096, leitor: 'src/features/crm/messaging/whatsapp.params.js' },
  'integration.whatsapp.max_caption_chars': { min: 1, max: 1024, padrao: whatsapp.PADROES.maxCaptionChars, esperado: 1024, leitor: 'src/features/crm/messaging/whatsapp.params.js' },
  'integration.whatsapp.max_template_var_chars': { min: 1, max: 32768, padrao: whatsapp.PADROES.maxTemplateVarChars, esperado: 1024, leitor: 'src/features/crm/messaging/whatsapp.params.js' },
  'integration.messaging.record_body_max_chars': { min: 1, max: 1048576, padrao: mensageria.PADROES.recordBodyMaxChars, esperado: 65536, leitor: 'src/features/crm/messaging/messaging.params.js' },
};

test('m9r16 cada limite está no dicionário com a faixa do canal, no parametros.csv com o mesmo padrão, na tela do Front e é lido pelo código', () => {
  const csv = fs.readFileSync(path.join(RAIZ, '..', 'Maturacao', 'demandas', 'parametros.csv'), 'utf8');
  const tela = fs.readFileSync(path.join(RAIZ, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes', 'integracoesMensageriaGroups.js'), 'utf8');
  for (const [chave, { min, max, padrao, esperado, leitor }] of Object.entries(CHAVES)) {
    assert.deepEqual(SETTINGS_SCHEMA[chave], { type: 'integer', min, max }, `${chave} no dicionário`);
    assert.equal(padrao, esperado, `${chave}: padrão do código`);
    const linha = csv.split('\n').find((l) => l.startsWith(`"${chave}"`));
    assert.ok(linha, `${chave} no parametros.csv`);
    assert.match(linha, new RegExp(`"inteiro","${esperado}","${min} a ${max}`), `${chave}: padrão e faixa no catálogo`);
    assert.match(linha, /"DI-M9R-16"/);
    assert.match(tela, new RegExp(`key: "${chave.replace(/\./g, '\\.')}"[^}]*defaultValue: ${esperado},`), `${chave} na tela do Front`);
    assert.ok(fs.readFileSync(path.join(RAIZ, leitor), 'utf8').includes(`'${chave}'`), `${chave} lido por ${leitor}`);
  }
  assert.deepEqual(whatsapp.TETOS, { maxTextChars: 4096, maxCaptionChars: 1024, maxTemplateVarChars: 32768 }, 'o teto do leitor é o mesmo da faixa');
  assert.equal(mensageria.RECORD_BODY_TETO, 1048576);
});

test('m9r16 limite do envio: conta caracteres (emoji = 1), para no primeiro além do limite e cita o campo', () => {
  const wa = { maxTextChars: 3, maxCaptionChars: 2, maxTemplateVarChars: 1 };
  assert.doesNotThrow(() => assertSendTextLimits({ text: '😀😀😀', caption: 'ab', templateVars: ['z', ''] }, wa));
  const erro = (input) => { try { assertSendTextLimits(input, wa); return null; } catch (e) { return [e.statusCode, e.code, e.details.fields[0], e.details.maxChars]; } };
  assert.deepEqual(erro({ text: '😀😀😀😀' }), [400, 'MESSAGE_VALIDATION', 'text', 3]);
  assert.deepEqual(erro({ caption: 'abc' }), [400, 'MESSAGE_VALIDATION', 'caption', 2]);
  assert.deepEqual(erro({ templateVars: ['a', 'bc'] }), [400, 'MESSAGE_VALIDATION', 'templateVars', 1]);
  assert.equal(erro({ text: null, caption: undefined, templateVars: null }), null, 'campos ausentes não contam');
  const t0 = Date.now();
  assert.deepEqual(erro({ text: 'x'.repeat(20 * 1048576) }), [400, 'MESSAGE_VALIDATION', 'text', 3]);
  assert.ok(Date.now() - t0 < 200, 'texto de 20 MB: a contagem para no limite');
});
