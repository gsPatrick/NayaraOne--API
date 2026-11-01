'use strict';

// M9-D870 (reabertura M-5 da rodada 5 de Marketing): TODAS as chaves marketing.* são classificadas: com permissão dona na camada de escrita (restrictedPermissionOf, que PUT /settings,
// PATCH e POST /feature-flags e upsertSetting consultam) ou numa lista explícita de livres; chave nova sem classificação falha o teste. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { restrictedPermissionOf } = require('../../../src/features/settings/settingRestricted');

const URL_KEYS = ['max_urls_verificadas', 'extensoes_arquivo', 'tlds_reconhecidos', 'dominios_permitidos', 'encurtadores', 'max_saltos', 'max_comprimento', 'verificar_destino', 'timeout_s', 'max_chars_variavel', 'max_chars_campo', 'max_chars_total', 'revisao_sem_aprovador'];
// Parâmetros operacionais de Marketing (tamanhos, horários, textos de apoio): graváveis por quem tem settings:update. Nova família: dê um dono em settingRestricted.js ou inclua aqui.
const FREE_FAMILIES = ['attribution', 'blog', 'campanhas', 'channel', 'cliente_frio', 'conteudo', 'custos', 'drill', 'email', 'lead_novo', 'locacao', 'mass', 'pos_chaves', 'preview', 'publicacoes', 'review', 'runner', 'schedule', 'segment', 'seo', 'social', 'templates', 'video', 'whatsapp', 'worker'];
const family = (key) => key.split('.')[1];

test('m9d870 M-5 as 13 chaves marketing.url.* têm permissão dona e nenhuma ficou de fora do dicionário', () => {
  const urlKeys = Object.keys(SETTINGS_SCHEMA).filter((k) => k.startsWith('marketing.url.'));
  assert.deepEqual(urlKeys.map((k) => k.slice('marketing.url.'.length)).sort(), [...URL_KEYS].sort(), 'o dicionário e o teste enumeram as mesmas chaves');
  for (const key of urlKeys) assert.equal(restrictedPermissionOf(key), 'marketing:automation:manage', key);
});

test('m9d870 M-5 toda chave marketing.* é protegida (dono) ou de família livre declarada; chave de família nova falha fechada', () => {
  const unclassified = Object.keys(SETTINGS_SCHEMA).filter((k) => k.startsWith('marketing.') && !restrictedPermissionOf(k) && !FREE_FAMILIES.includes(family(k)));
  assert.deepEqual(unclassified, [], `classifique em settingRestricted.js ou em FREE_FAMILIES: ${unclassified.join(', ')}`);
  const wronglyFree = FREE_FAMILIES.filter((f) => Object.keys(SETTINGS_SCHEMA).some((k) => k.startsWith(`marketing.${f}.`) && restrictedPermissionOf(k)));
  assert.deepEqual(wronglyFree, [], 'família livre com chave protegida');
  for (const f of ['url', 'consent', 'suppression', 'restricao', 'killswitch', 'permissoes', 'factual', 'autopublish', 'cadencia', 'public_fields']) {
    const keys = Object.keys(SETTINGS_SCHEMA).filter((k) => family(k) === f && k.startsWith('marketing.'));
    assert.ok(keys.length > 0, `família ${f} existe`);
    for (const key of keys) assert.ok(restrictedPermissionOf(key), `${key} sem dono`);
  }
});
