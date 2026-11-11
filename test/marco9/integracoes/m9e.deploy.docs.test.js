'use strict';

// Verificação K=7 do e-mail de campanha, item 8: o deploy documenta o cofre de segredos (variáveis, pasta persistente com escrita para o uid do container,
// chave gerada com openssl, ordem "cofre antes da versão"), o .env.example traz as variáveis sem valor real e a imagem cria a pasta com o dono certo.
// Sem banco: lê os arquivos do repositório.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const VARS = ['SECRET_STORE_DRIVER', 'SECRET_STORE_DIR', 'SECRET_STORE_MASTER_KEY'];
const DIR = '/var/lib/nayara/cofre';

test('deploy_do_marco_9_documenta_o_cofre_e_a_ordem_cofre_antes_da_versao', () => {
  const doc = read('docs/DEPLOY_MARCO_9.md');
  for (const v of VARS) assert.match(doc, new RegExp(`\`${v}\``), `${v} no roteiro de deploy`);
  assert.match(doc, /openssl rand -hex 32/);
  assert.ok(doc.includes(DIR), 'a pasta do cofre');
  assert.match(doc, /uid 1001/); assert.match(doc, /chown -R 1001:1001/);
  assert.match(doc, /persistente/);
  const ordem = doc.slice(doc.indexOf('## Ordem'));
  assert.match(ordem, /^0\. Configurar o cofre de segredos \*\*antes\*\* de publicar esta versão/m, 'o passo 0 é o cofre, antes do deploy da API (passo 3)');
  assert.ok(ordem.indexOf('0. Configurar o cofre') < ordem.indexOf('3. Deploy da API'));
  assert.match(doc, /INTEGRATION_SECRET_STORE_UNUSABLE/); assert.match(doc, /secretStore\.status = "ok"/);
  assert.match(doc, /20260101000757-marketing-campaign-delivery-retry\.js/, 'a migration desta correção');
  assert.match(doc, /COFRE_DE_SEGREDOS\.md/, 'aponta o runbook');
  assert.ok(!/[0-9a-f]{64}/i.test(doc), 'nenhuma chave real');
});

test('env_example_tem_as_variaveis_do_cofre_sem_valor_real', () => {
  const ex = read('.env.example');
  for (const v of VARS) assert.match(ex, new RegExp(`^#? ?${v}=`, 'm'), `${v} no .env.example`);
  assert.match(ex, /^SECRET_STORE_DRIVER=$/m, 'driver vazio (sem cofre só o SANDBOX sobe)');
  assert.match(ex, /^# SECRET_STORE_MASTER_KEY=$/m, 'chave mestra sem valor');
  assert.match(ex, /openssl rand -hex 32/);
  assert.ok(ex.includes(DIR));
  assert.ok(!/SECRET_STORE_MASTER_KEY=\S/.test(ex), 'nunca um valor de chave');
});

test('dockerfile_cria_a_pasta_do_cofre_fora_de_app_com_dono_1001_antes_de_trocar_de_usuario', () => {
  const df = read('Dockerfile');
  const linha = df.split('\n').find((l) => l.startsWith('RUN') && l.includes(DIR));
  assert.ok(linha, 'RUN que cria a pasta do cofre');
  assert.match(linha, new RegExp(`mkdir -p ${DIR}`)); assert.match(linha, new RegExp(`chown -R nodeapi:nodejs ${DIR}`)); assert.match(linha, new RegExp(`chmod 700 ${DIR}`));
  assert.ok(df.indexOf(linha) < df.indexOf('USER nodeapi'), 'antes de USER nodeapi');
  assert.match(df, /adduser --system --uid 1001 nodeapi/, 'o dono é o uid 1001');
  assert.ok(!DIR.startsWith('/app'), 'o cofre recusa pasta dentro do repositório (/app)');
});

test('runbook_do_cofre_explica_o_estado_no_health_e_o_reprocessamento_da_campanha_cfc5c8e1', () => {
  const rb = read('docs/runbooks/COFRE_DE_SEGREDOS.md');
  assert.match(rb, /GET \/api\/health/); assert.match(rb, /INTEGRATION_SECRET_STORE_UNUSABLE/);
  assert.match(rb, /POST \/api\/v1\/marketing\/campaigns\/:id\/deliveries\/reprocess/);
  assert.match(rb, /cfc5c8e1-784c-4b1f-abc9-60411dbf67f3/);
  assert.match(rb, /node scripts\/reprocessarEntregasCampanha\.js/);
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/reprocessarEntregasCampanha.js')));
});
