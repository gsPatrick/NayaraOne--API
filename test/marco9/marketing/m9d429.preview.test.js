'use strict';

// M9-D429 regra 5 — previewSafe: os 8 padrões sensíveis (cada um com um caso positivo), o preço de imóvel do Radar que passa, a redação de trecho,
// a recusa de frase sensível e os parâmetros do preview (tamanho, dicionários, regex de contrato, texto seguro). A parte pura roda sem banco.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { getSeedTenant, withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const messaging = require('../../../src/features/marketing/publications/messaging');

const { previewSafe, readPreviewConfig, PREVIEW_SETTING_DEFAULTS } = messaging;
const { parseTerms } = require('../../../src/features/marketing/publications/messaging/preview/preview.settings');
const CFG = { terms: parseTerms(PREVIEW_SETTING_DEFAULTS['marketing.preview.termos_sensiveis']), contractPattern: PREVIEW_SETTING_DEFAULTS['marketing.preview.padrao_contrato'] };
const check = (text, maxChars = 60) => previewSafe(text, CFG, { maxChars });

let A;
before(async () => { A = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

test('previewsafe_detecta_os_8_padroes_e_permite_preco_de_imovel', () => {
  const positivos = {
    CPF: ['Seu CPF 123.456.789-09 foi atualizado', 'confirme 52998224725 por favor'],
    CNPJ: ['Empresa 11.222.333/0001-81 cadastrada', 'cnpj 11222333000181 ok'],
    DIVIDA: ['Olá Marta, sua parcela de R$ 1.250,00 vence amanhã.', 'Há uma dívida de 800 reais em aberto.', 'Multa de R$ 90,50 por atraso.'],
    SALDO: ['Seu saldo é R$ 3.000,00 hoje.', 'Extrato: R$ 120,00 disponíveis.', 'O limite de 5000 reais foi ajustado.'],
    CONTRATO: ['Contrato LOC-2026-0001 pronto', 'Veja o VEN-2026-0042'],
    ENDERECO: ['Visita na Rua das Acácias, 120', 'Entrega na Avenida Paulista 1578'],
    RESTRICAO: ['Há restrição no seu nome', 'Você foi negativado', 'Seu score caiu', 'Protesto registrado', 'Consulta ao Serasa feita', 'Aparece no SPC'],
    SAUDE: ['Recebemos o laudo médico', 'Seu diagnóstico foi anexado', 'tratamento em andamento', 'Doença informada', 'Dados de deficiência recebidos', 'CID informado no cadastro'],
  };
  for (const [pattern, textos] of Object.entries(positivos)) {
    for (const text of textos) {
      const r = check(text);
      assert.equal(r.safe, false, `${pattern}: "${text}" deveria ser sensível`);
      assert.ok(r.patterns.includes(pattern), `${pattern} não detectado em "${text}": ${r.patterns}`);
    }
  }
  // o preço do imóvel do Radar, sem termo de dívida ou de saldo, passa; telefone de 11 dígitos não é CPF; cidade não é CID
  for (const ok of ['Novo imóvel no Radar por R$ 780.000 no Jardim Europa', 'Casa com 3 quartos por 1.200.000 reais', 'Ligue 11999990000 ou (71) 3333-4444', 'Visite nossa cidade', 'Você tem uma atualização no portal.', 'Olá Marta, você tem uma atualização no portal.']) {
    assert.equal(check(ok).safe, true, `"${ok}" deveria passar`);
  }
  // CPF com dígitos verificadores inválidos e sem pontuação não é CPF (pode ser protocolo); com pontuação é tratado como CPF
  assert.equal(check('protocolo 12345678900').safe, true);
  assert.equal(check('cpf 123.456.789-00').safe, false);
});

test('preview_nao_revela_informacao_sensivel', () => {
  // trecho (CPF, CNPJ, contrato, endereço) vira [REDIGIDO]
  const cpf = check('Seu CPF 123.456.789-09 foi atualizado');
  assert.deepEqual([cpf.safe, cpf.refused, cpf.text], [false, false, 'Seu CPF [REDIGIDO] foi atualizado']);
  assert.equal(check('Contrato LOC-2026-0001 e Rua Bahia, 10').text, 'Contrato [REDIGIDO] e [REDIGIDO]');
  // frase sensível não se redige: recusa, com a lista dos padrões
  const debt = check('Olá Marta, sua parcela de R$ 1.250,00 vence amanhã.');
  assert.deepEqual([debt.safe, debt.refused, debt.text, debt.patterns], [false, true, null, ['DIVIDA']]);
  // só vale o que aparece na notificação: o dado sensível depois dos 60 primeiros caracteres não é preview (o corpo do WhatsApp segue a política do canal)
  const longe = `${'Oi, temos uma novidade importante para você sobre o seu atendimento. '}Seu CPF 123.456.789-09`;
  assert.equal(check(longe, 60).safe, true);
  assert.equal(check(longe, 200).safe, false);
  // sem limite (assunto e pré-cabeçalho do e-mail), o texto inteiro é preview
  assert.equal(previewSafe(longe, CFG).safe, false);
});

test('parametros_do_preview_tem_o_padrao_do_livro_sao_validados_e_mudam_o_resultado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const padrao = await readPreviewConfig(A, t);
    assert.deepEqual([padrao.maxChars, padrao.safeText, padrao.unsubscribeUrl], [60, 'Você tem uma atualização. Acesse o portal.', null]);
    assert.deepEqual(Object.keys(padrao.terms).sort(), ['divida', 'restricao', 'saldo', 'saude']);
    // dicionário da empresa: acrescenta um termo e o padrão passa a detectar
    assert.equal(previewSafe('Seu boleto de R$ 100,00 está pendente.', padrao, { maxChars: 60 }).safe, true);
    await upsertSetting('marketing.preview.termos_sensiveis', `${PREVIEW_SETTING_DEFAULTS['marketing.preview.termos_sensiveis'].replace('divida: ', 'divida: boleto, ')}`, A, A.userId, t);
    const novo = await readPreviewConfig(A, t);
    assert.equal(previewSafe('Seu boleto de R$ 100,00 está pendente.', novo, { maxChars: 60 }).refused, true);
    await upsertSetting('marketing.preview.max_chars', 10, A, A.userId, t);
    assert.equal((await readPreviewConfig(A, t)).maxChars, 10);
    await upsertSetting('marketing.preview.padrao_contrato', '\\bPED-\\d{6}\\b', A, A.userId, t);
    assert.equal(previewSafe('pedido PED-123456 aprovado', await readPreviewConfig(A, t), { maxChars: 60 }).patterns[0], 'CONTRATO');
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    assert.match((await readPreviewConfig(A, t)).unsubscribeUrl, /\{token\}/);
    // valores inválidos são recusados pela escrita
    const invalidos = [['marketing.preview.max_chars', 0], ['marketing.preview.max_chars', 501], ['marketing.preview.termos_sensiveis', 'divida: parcela'], ['marketing.preview.padrao_contrato', '(['], ['marketing.preview.padrao_contrato', '.*'],
      ['marketing.preview.texto_seguro', 'curto'], ['marketing.email.url_descadastro', 'http://sem-token.test'], ['marketing.email.url_descadastro', 'https://site.test/sem-marcador']];
    for (const [key, value] of invalidos) {
      await assert.rejects(() => upsertSetting(key, value, A, A.userId, t), (e) => ['MKT_PARAM_INVALID', 'SETTING_INVALID_VALUE'].includes(e.code), `${key}=${value}`);
    }
  });
});
