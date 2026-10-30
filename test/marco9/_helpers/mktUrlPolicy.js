'use strict';

// Política de URL externa dos testes do Marketing (M9-D433): os endereços fictícios dos cenários (exemplo.com.br, exemplo.test, g.page) entram na allowlist da empresa e
// a verificação de DNS e redirecionamento fica desligada (sem rede nos testes). Tudo por parâmetro da empresa, na transação do teste. Não é teste.
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const TEST_DOMAINS = 'exemplo.com.br, exemplo.test, g.page';

async function allowTestUrls(t, tenant) {
  await upsertSetting('marketing.url.dominios_permitidos', TEST_DOMAINS, tenant, tenant.userId, t);
  await upsertSetting('marketing.url.verificar_destino', false, tenant, tenant.userId, t);
}

module.exports = { allowTestUrls, TEST_DOMAINS };
