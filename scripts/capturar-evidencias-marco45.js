#!/usr/bin/env node
'use strict';
/**
 * Captura de evidências HTTP/serviço/SQL dos Marcos 4 e 5 no Postgres DESCARTÁVEL com o seed de
 * dois tenants (scripts/seed-ci-two-tenants.js). Pré-requisito: o ambiente do CI
 * (scripts/reproduzir-conferencia.sh prepara tudo e chama este script quando REPRO_CAPTURA=1).
 *
 * Saída: docs/entrega-marco45/captura-descartavel.json (ou o caminho passado em --out).
 * Nunca chama endpoint de MFA, nunca forja token; tokens e senhas não são gravados.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

process.env.PORT = process.env.CAPTURA_PORT || '21690';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : path.join(__dirname, '..', 'docs', 'entrega-marco45', 'captura-descartavel.json');

async function main() {
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  if (!password) throw new Error('CI_TENANT_USERS_PASSWORD ausente: rode dentro do ambiente descartável.');
  require('../app');
  const { sequelize } = require('../src/models');
  await new Promise((r) => setTimeout(r, 600));
  const { Runner } = require('./captura-marco45/runner');
  const R = new Runner({ baseUrl: `http://127.0.0.1:${process.env.PORT}/api/v1`, password });
  const usuarios = [];
  for (const tenant of ['A', 'B']) {
    for (const perfil of ['maker', 'checker', 'leitura', 'gestor']) {
      const quem = await R.login(tenant, perfil);
      usuarios.push({ rotulo: quem, tenant, perfil, email: require('./seed-ci-two-tenants').emailFor(tenant, perfil), permissoes: R.claims[quem].permissions });
    }
  }

  const only = process.env.CAPTURA_SO; // ex.: "marco4"
  if (!only || only === 'marco4') await require('./captura-marco45/cenarios-marco4')(R);
  if (!only || only === 'marco5') await require('./captura-marco45/cenarios-marco5')(R);
  await require('./captura-marco45/consultas-banco')(R);

  const [[pg]] = await sequelize.query('select version() as v');
  const [[role]] = await sequelize.query('select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user');
  let commit = 'desconhecido';
  try { commit = execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch (_) { /* fora de git */ }
  const doc = {
    meta: {
      gerador: 'scripts/capturar-evidencias-marco45.js',
      commit,
      quando: new Date().toISOString(),
      postgres: pg.v,
      node: process.version,
      roleDaSuite: role,
      sanitizacao: [
        'Tokens de acesso e de renovação e senhas não são gravados: valores substituídos por [REDACTED].',
        'Corpos de resposta HTTP gravados como vieram (campos null preservados, nada truncado, nada traduzido).',
        'Os usuários são fictícios (ci-<tenant>-<perfil>@ci.nayaraone.test); a senha existe só no banco descartável.',
      ],
    },
    usuarios,
    passos: R.passos,
    consultas: R.consultas,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
  const div = R.passos.filter((p) => !p.ok).length + R.consultas.filter((c) => !c.invarianteOk).length;
  console.log(`[captura] ${R.passos.length} passos, ${R.consultas.length} consultas, ${div} divergência(s) → ${OUT}`);
  await sequelize.close().catch(() => {});
  process.exit(div ? 3 : 0);
}

main().catch((err) => { console.error('[captura] falha:', err); process.exit(1); });
