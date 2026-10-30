'use strict';

// M9-D427 — a contingência do canal SITE é da M9-D430 (item 8) e o adapter é o SiteAdapter da M9-D259: a página pública e o SEO não criam modo próprio
// de contingência, não chamam fornecedor e leem o cadastro só pelas visões públicas. Teste estático, sem banco.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const adapters = require('../../../src/features/marketing/publications/adapters');

const SEO_DIR = path.join(__dirname, '..', '..', '..', 'src', 'features', 'marketing', 'publications', 'seo');
const BLOG_DIR = path.join(__dirname, '..', '..', '..', 'src', 'features', 'marketing', 'content', 'blog');
const read = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);

test('contingencia_do_site_e_a_da_m9d430_e_o_seo_nao_cria_modo_proprio', () => {
  const plan = adapters.planFor('SITE');
  assert.deepEqual([plan.owner, plan.mode, plan.keepInternal, plan.refs], ['M9-D430', 'KEEP_INTERNAL_AND_REPROCESS', true, ['M9-D259']]);
  for (const [file, text] of read(SEO_DIR)) {
    assert.ok(!/KEEP_INTERNAL|QUEUE_AND_ALTERNATE|PENDING_SYNC|contingency/i.test(text), `${file} não pode definir modo de contingência`);
    assert.ok(!/fetch\(|axios|require\('(node:)?https?'\)|IntegrationHttpClient/.test(text), `${file} não pode chamar fornecedor`);
  }
});

test('seo_e_blog_leem_o_cadastro_so_pelas_visoes_publicas_e_nao_tem_valor_fixo_de_parametro', () => {
  for (const [file, text] of [...read(SEO_DIR), ...read(BLOG_DIR)]) {
    assert.ok(!/real_estate\.(properties|property_)/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${file} lê tabela de origem em vez da visão pública`);
  }
  // os padrões dos parâmetros moram só nos arquivos de settings
  for (const [file, text] of [...read(SEO_DIR), ...read(BLOG_DIR)].filter(([f]) => !f.endsWith('.settings.js'))) {
    assert.ok(!/SELO_E_REDIRECT'|ibge\.gov\.br'|cnj\.jus\.br/.test(text), `${file} repete valor padrão de parâmetro`);
  }
});
