'use strict';

// M9-D908 (reabertura R5-L3): o vínculo do relatório DRY3 à empresa está dito na documentação do caminho oficial (README da migração e .env.example), e o motivo que o GO devolve existe de fato.
// Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('m9d908 R5-L3 o README explica que o laboratório ensaia com o UUID da empresa de produção, senão o GO recusa OTHER_COMPANY', () => {
  const readme = read('src/features/migration-v2/README.md');
  const official = readme.slice(readme.indexOf('## Caminho oficial do relatório DRY3'));
  assert.ok(official.length > 200, 'seção do caminho oficial existe');
  for (const needle of ['OTHER_COMPANY', 'UUID da empresa de produção', 'dry3-report.<uuid-da-empresa>.json', 'MIGRATION_DRY3_SIGNING_KEY', 'MIGRATION_DRY3_REPORT_PATH', 'report_id']) assert.ok(official.includes(needle), `README sem: ${needle}`);
});

test('m9d908 R5-L3 o .env.example avisa do vínculo à empresa e o código usa o mesmo motivo e o mesmo nome de arquivo', () => {
  const env = read('.env.example');
  assert.match(env, /VÍNCULO À EMPRESA[\s\S]*OTHER_COMPANY/);
  assert.ok(read('src/features/migration-v2/dryrun/dry.validity.js').includes("'OTHER_COMPANY'"));
  assert.ok(read('src/features/migration-v2/dryrun/dry.export.js').includes('`${base.slice(0, base.length - ext.length)}.${companyId}${ext}`'), 'arquivo por empresa: dry3-report.<empresa>.json');
});
