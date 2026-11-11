#!/usr/bin/env node
'use strict';
/**
 * Captura ao vivo do fechamento do Marco 5: sobe o app Express NESTE processo (porta própria),
 * faz login normal com os usuários fictícios do seed de dois tenants e roda os módulos de
 * cenários (scripts/captura-m5/modulos/*.js). Cada passo HTTP/serviço/SQL leva os ids de
 * requisito do caderno. Só roda dentro do banco DESCARTÁVEL (DISPOSABLE_DB=1, criado por
 * scripts/withDisposableDb.js); recusa qualquer outro banco.
 *
 * Uso (uma linha, da raiz da API):
 *   npm run captura:m5
 * ou, para um módulo só, enquanto se ajusta:
 *   CAPTURA_M5_MODULOS=contratos CAPTURA_M5_PORT=5534 node scripts/withDisposableDb.js --port 5533 -- env CI_TENANT_USERS_PASSWORD=ci-tenant-users-password-not-for-production bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node scripts/captura-m5/index.js --out /tmp/x.json"
 *
 * Saída (--out): JSON com meta (commit, data, Node, Postgres, role), usuarios, passos[] e
 * consultas[]. Tokens e senhas nunca são gravados.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

if (process.env.DISPOSABLE_DB !== '1') {
  console.error('[captura-m5] RECUSADO: rode só dentro de scripts/withDisposableDb.js (banco descartável).');
  process.exit(2);
}
process.env.PORT = process.env.CAPTURA_M5_PORT || '5539';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : path.join(__dirname, '..', '..', 'docs', 'entrega-marco5', 'captura-m5.json');
const MODULOS_DIR = path.join(__dirname, 'modulos');

function listarModulos() {
  const todos = fs.readdirSync(MODULOS_DIR).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')).sort();
  const pedido = (process.env.CAPTURA_M5_MODULOS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return pedido.length ? todos.filter((m) => pedido.includes(m)) : todos;
}

async function main() {
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  if (!password) throw new Error('CI_TENANT_USERS_PASSWORD ausente: rode dentro do ambiente descartável.');
  const dbUrl = process.env.DATABASE_URL || '';
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(dbUrl)) throw new Error('RECUSADO: DATABASE_URL não é local.');
  require('../../app');
  const { sequelize } = require('../../src/models');
  await new Promise((r) => setTimeout(r, 800));
  const { RunnerM5 } = require('./runner');
  const { emailFor } = require('../seed-ci-two-tenants');
  const R = new RunnerM5({ baseUrl: `http://127.0.0.1:${process.env.PORT}/api/v1`, password });
  const usuarios = [];
  for (const tenant of ['A', 'B']) {
    for (const perfil of ['maker', 'checker', 'leitura', 'gestor']) {
      const quem = await R.login(tenant, perfil);
      usuarios.push({ rotulo: quem, tenant, perfil, email: emailFor(tenant, perfil), permissoes: R.claims[quem].permissions });
    }
  }
  const modulos = listarModulos();
  const falhasModulo = [];
  for (const m of modulos) {
    R.moduloAtual = m;
    const antes = R.passos.length + R.consultas.length;
    try {
      await require(path.join(MODULOS_DIR, `${m}.js`))(R);
    } catch (err) {
      falhasModulo.push({ modulo: m, erro: err.message });
      console.error(`[captura-m5] módulo ${m} abortou: ${err.stack}`);
    }
    console.log(`[captura-m5] módulo ${m}: ${R.passos.length + R.consultas.length - antes} passos`);
  }

  const [[pg]] = await sequelize.query('select version() as v');
  const [[role]] = await sequelize.query('select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user');
  let commit = 'desconhecido';
  try { commit = execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..', '..') }).toString().trim(); } catch (_) { /* fora de git */ }
  const doc = {
    meta: {
      gerador: 'scripts/captura-m5/index.js',
      commit,
      quando: new Date().toISOString(),
      postgres: pg.v,
      node: process.version,
      roleDaSuite: role,
      modulos,
      falhasModulo,
      sanitizacao: [
        'Tokens de acesso e de renovação e senhas não são gravados: valores substituídos por [REDACTED].',
        'Corpos de resposta HTTP gravados como vieram (campos null preservados).',
        'Usuários fictícios (ci-<tenant>-<perfil>@ci.nayaraone.test); a senha existe só no banco descartável, apagado ao fim.',
      ],
    },
    usuarios,
    passos: R.passos,
    consultas: R.consultas,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
  const div = R.passos.filter((p) => !p.ok).length + R.consultas.filter((c) => !c.invarianteOk).length;
  console.log(`[captura-m5] ${R.passos.length} passos, ${R.consultas.length} consultas, ${div} divergência(s), ${falhasModulo.length} módulo(s) abortado(s) -> ${OUT}`);
  await sequelize.close().catch(() => {});
  process.exit(div || falhasModulo.length ? 3 : 0);
}

main().catch((err) => { console.error('[captura-m5] falha:', err); process.exit(1); });
