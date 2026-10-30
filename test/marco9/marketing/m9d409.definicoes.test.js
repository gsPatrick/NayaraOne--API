'use strict';

// M9-D409 — definição dos 10 tipos, percentual da redução e canais permitidos (sem banco: regras puras).
// node scripts/withDisposableDb.js ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d409.definicoes.test.js

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const types = require('../../../src/features/marketing/content/types');
const { CONTENT_TYPES } = require('../../../src/features/marketing/content/content.input');
const { reductionPercent } = require('../../../src/features/marketing/content/types/priceReduction');
const { missingFields } = require('../../../src/features/marketing/content/types/validate');
const { buildTriggeredText } = require('../../../src/features/marketing/content/types/texts');
const { validateAgainstFacts } = require('../../../src/features/marketing/content/pipeline.factualPort');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

after(async () => { await sequelize.close(); });

const EXPECTED = ['NEW_PROPERTY', 'PRICE_REDUCTION', 'SOLD_RENTED', 'NAYARA_CONSTRUCTION', 'INSTITUTIONAL', 'EDUCATIONAL_BLOG', 'POST_SALE', 'BIRTHDAY_RELATIONSHIP', 'SEGMENTED_CAMPAIGN', 'VIDEO_REEL'];

// 1
test('cada_tipo_tem_definicao_completa', () => {
  assert.deepEqual(Object.keys(types.DEFINITIONS).sort(), [...EXPECTED].sort());
  assert.deepEqual([...CONTENT_TYPES].sort(), [...EXPECTED].sort(), 'o enum da API é o mesmo dos 10 tipos');
  for (const type of EXPECTED) {
    const def = types.DEFINITIONS[type];
    assert.equal(def.type, type);
    assert.ok(Array.isArray(def.requiredFields.input) && Array.isArray(def.requiredFields.facts), `${type}: requiredFields`);
    assert.ok(def.requiredFields.input.length + def.requiredFields.facts.length > 0, `${type}: campos mínimos declarados`);
    assert.ok(def.allowedChannels.length > 0, `${type}: canais permitidos`);
    assert.ok(['property', 'construction', 'person', 'none'].includes(def.sourceLoader), `${type}: sourceLoader`);
    assert.ok(['public', 'private', 'human'].includes(def.sanitizerProfile), `${type}: sanitizerProfile`);
    assert.match(def.defaultTemplateCode, /^[A-Z_]+$/, `${type}: defaultTemplateCode`);
    assert.throws(() => { def.allowedChannels.push('X'); }, TypeError, 'a definição é imutável');
  }
});

// 2
test('reducao_de_preco_so_dispara_em_queda', () => {
  assert.equal(reductionPercent(800000, 780000).isReduction, true);
  assert.equal(reductionPercent(800000, 820000).isReduction, false, 'aumento não é redução');
  assert.equal(reductionPercent(800000, 800000).isReduction, false, 'preço igual não é redução');
  assert.equal(reductionPercent(null, 780000).isReduction, false);
  assert.equal(reductionPercent(0, 10).isReduction, false);
});

// 6
test('percentual_de_reducao_2_casas', () => {
  assert.equal(reductionPercent(800000, 780000).percent, '2,50');
  assert.equal(reductionPercent('800000.00', '780000.00', 2).percentValue, '2.50');
  assert.equal(reductionPercent(300000, 299999).percent, '0,00', 'queda minúscula arredonda para 0,00 mas continua sendo queda');
  assert.equal(reductionPercent(300000, 290000).percent, '3,33');
  assert.equal(reductionPercent(300000, 280000).percent, '6,67', 'meio para cima: 6,666...');
  assert.equal(reductionPercent(1000, 995).percent, '0,50');
  assert.equal(reductionPercent(200, 199.99).percent, '0,01');
  // parametrizável (não fixo no código): 0 e 4 casas
  assert.equal(reductionPercent(800000, 780000, 0).percent, '3');
  assert.equal(reductionPercent(800000, 780000, 4).percent, '2,5000');
});

// 4 (regra pura; o 422 por HTTP está no teste de criação)
test('aniversario_nao_vai_para_rede_social', () => {
  const def = types.getDefinition('BIRTHDAY_RELATIONSHIP');
  for (const channel of ['INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'TIKTOK', 'YOUTUBE', 'SITE', 'PORTAL']) {
    assert.throws(() => types.assertChannelsAllowed(def, [channel]), (e) => e.statusCode === 422 && e.code === 'MKT_CONTENT_CHANNEL_NOT_ALLOWED', channel);
  }
  assert.doesNotThrow(() => types.assertChannelsAllowed(def, ['whatsapp', 'EMAIL']));
  assert.throws(() => types.assertChannelsAllowed(types.getDefinition('POST_SALE'), ['INSTAGRAM']), (e) => e.code === 'MKT_CONTENT_CHANNEL_NOT_ALLOWED');
  assert.throws(() => types.assertChannelsAllowed(types.getDefinition('SOLD_RENTED'), ['WHATSAPP']), (e) => e.code === 'MKT_CONTENT_CHANNEL_NOT_ALLOWED');
  assert.doesNotThrow(() => types.assertChannelsAllowed(types.getDefinition('NEW_PROPERTY'), ['INSTAGRAM', 'SITE']));
});

test('tipo_inexistente_devolve_400_MKT_CONTENT_TYPE_INVALID', () => {
  for (const bad of ['NOPE', 'new_property', undefined, null, 7, '__proto__', 'constructor']) {
    assert.throws(() => types.getDefinition(bad), (e) => e.statusCode === 400 && e.code === 'MKT_CONTENT_TYPE_INVALID' && /Tipo de conteúdo inválido/.test(e.message), String(bad));
  }
});

test('campos_minimos_por_tipo_sao_conferidos', () => {
  const full = { tipo: 'RESIDENTIAL', finalidade: 'VENDA', bairro: 'Jardim Europa', precoVenda: 780000, quartos: 3, fotosAutorizadas: ['a'] };
  const def = types.getDefinition('NEW_PROPERTY');
  assert.deepEqual(missingFields(def, { sourceEntityId: 'x' }, full, 1), { input: [], facts: [] });
  assert.deepEqual(missingFields(def, {}, { ...full, bairro: null }, 1), { input: ['sourceEntityId'], facts: ['bairro'] });
  assert.deepEqual(missingFields(def, { sourceEntityId: 'x' }, { ...full, fotosAutorizadas: [] }, 1).facts, ['fotosAutorizadas']);
  assert.deepEqual(missingFields(def, { sourceEntityId: 'x' }, { ...full, fotosAutorizadas: ['a'] }, 2).facts, ['fotosAutorizadas'], 'mínimo de fotos vem do parâmetro');
  assert.deepEqual(missingFields(def, { sourceEntityId: 'x' }, { ...full, precoVenda: null, precoLocacao: 4200 }, 1).facts, [], 'venda OU locação');
  assert.deepEqual(missingFields(def, { sourceEntityId: 'x' }, { ...full, quartos: 0 }, 1).facts, [], 'zero quartos (studio) é valor válido');
  const campaign = types.getDefinition('SEGMENTED_CAMPAIGN');
  assert.deepEqual(missingFields(campaign, { campaignId: 'c', channels: ['EMAIL'] }, {}, 1).input, ['templateId|templateCode']);
  assert.deepEqual(missingFields(campaign, { campaignId: 'c', channels: ['EMAIL'], templateCode: 'T' }, {}, 1).input, []);
  assert.deepEqual(missingFields(types.getDefinition('INSTITUTIONAL'), { title: ' ' }, {}, 1).input, ['title', 'texto']);
  assert.deepEqual(missingFields(types.getDefinition('EDUCATIONAL_BLOG'), { tema: 'x', fontes: [] }, {}, 1).input, ['fontes']);
  assert.deepEqual(missingFields(types.getDefinition('VIDEO_REEL'), { texto: 'roteiro' }, {}, 1).input, ['midiaId|montagem']); // M9-D426: mídia pronta ou montagem
});

// 3 (parte pura: fatos e texto; a parte com banco está em m9d409.tipos.test.js)
test('texto_de_vendido_nao_cita_valor_e_o_validador_reprova_valor', () => {
  const facts = { tipo: 'RESIDENTIAL', bairro: 'Jardim Europa', status: 'VENDIDO' };
  const { texto } = buildTriggeredText('SOLD_RENTED', facts);
  assert.match(texto, /vendido/);
  assert.doesNotMatch(texto, /R\$|\d/);
  assert.equal(validateAgainstFacts(texto, facts).ok, true);
  const bad = validateAgainstFacts('Vendido por R$ 780.000,00 no Jardim Europa.', facts);
  assert.equal(bad.ok, false, 'valor final não é publicável');
  assert.ok(bad.findings.length > 0);
});

test('texto_da_reducao_traz_os_dois_valores_exatos_e_o_percentual', () => {
  const facts = { tipo: 'RESIDENTIAL', bairro: 'Jardim Europa', precoAnterior: 800000, precoVenda: 780000 };
  const { texto } = buildTriggeredText('PRICE_REDUCTION', facts, { percent: '2,50', currentPrice: 780000 });
  assert.match(texto, /R\$ 800\.000,00/);
  assert.match(texto, /R\$ 780\.000,00/);
  assert.match(texto, /2,50%/);
  assert.equal(validateAgainstFacts(texto, facts).ok, true, 'os valores do texto batem com os fatos');
});

test('parametros_do_tipo_estao_no_dicionario_de_configuracoes', () => {
  for (const key of Object.keys(types.TYPES_SETTINGS_SCHEMA)) assert.ok(SETTINGS_SCHEMA[key], `${key} no SETTINGS_SCHEMA`);
  assert.equal(types.TYPES_SETTING_DEFAULTS['marketing.conteudo.aniversario_hora'], '08:00');
  assert.equal(types.TYPES_SETTING_DEFAULTS['marketing.conteudo.reducao_casas_decimais'], 2);
  assert.equal(types.TYPES_SETTING_DEFAULTS['marketing.conteudo.minimo_fotos'], 1);
  const timeRule = types.TYPES_SETTINGS_SCHEMA['marketing.conteudo.aniversario_hora'].validate;
  assert.doesNotThrow(() => timeRule('k', '07:30'));
  for (const bad of ['25:00', '8:00', 'abc', '']) assert.throws(() => timeRule('k', bad), (e) => e.code === 'MKT_PARAM_INVALID');
  const listRule = types.TYPES_SETTINGS_SCHEMA['marketing.conteudo.tipos_rascunho_automatico'].validate;
  assert.doesNotThrow(() => listRule('k', 'NEW_PROPERTY, SOLD_RENTED'));
  assert.throws(() => listRule('k', 'INSTITUTIONAL'), (e) => e.code === 'MKT_PARAM_INVALID', 'tipo manual não tem rascunho automático');
});
