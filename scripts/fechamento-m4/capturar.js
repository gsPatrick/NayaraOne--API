#!/usr/bin/env node
'use strict';
/**
 * Captura ao vivo do fechamento do Marco 4 (matriz do caderno): requisições HTTP reais à API
 * (Express em processo, auth JWT real, tenant e RLS reais) no Postgres DESCARTÁVEL com o seed de
 * dois tenants. Cada passo é marcado com as linhas da matriz que prova.
 *
 *   node scripts/withDisposableDb.js --port 5527 -- env LOG_LEVEL=error \
 *     CI_TENANT_USERS_PASSWORD=<senha do seed descartável> CAPTURA_PORT=5528 \
 *     bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node scripts/fechamento-m4/capturar.js --out <saida.json>"
 *
 * Login sempre por POST /auth/login. Nunca chama endpoint de MFA por HTTP, nunca forja token: o
 * MFA dos usuários fictícios é habilitado e verificado pela camada de serviço com código TOTP real.
 * Tokens, senhas, segredos TOTP e o segredo do webhook não são gravados.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

process.env.PORT = process.env.CAPTURA_PORT || '5528';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : path.join(__dirname, 'captura-descartavel.json');
const SO = process.env.CAPTURA_SO ? process.env.CAPTURA_SO.split(',') : null;

const ETAPAS = [
  ['nucleo', './cenarios-nucleo'],
  ['pagamentos', './cenarios-pagamentos'],
  ['conciliacao', './cenarios-conciliacao'],
  ['terceiros', './cenarios-terceiros'],
  ['fechamento', './cenarios-fechamento'],
  ['relatorio', './cenarios-relatorio'],
  ['guia', './cenarios-guia'],
];

function git(cmd) {
  try { return execSync(`git ${cmd}`, { cwd: path.join(__dirname, '..', '..') }).toString().trim(); } catch (_) { return 'indisponível'; }
}

async function main() {
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  if (!password) throw new Error('CI_TENANT_USERS_PASSWORD ausente: rode dentro do ambiente descartável.');
  require('../../app');
  const { sequelize } = require('../../src/models');
  await new Promise((r) => setTimeout(r, 800));
  const { RunnerM4 } = require('./runner');
  const { inTenant, concederPermissoes, prepararAmbiente } = require('./ambiente');
  const R = new RunnerM4({ baseUrl: `http://127.0.0.1:${process.env.PORT}/api/v1`, password });
  const usuarios = [];
  for (const [tenant, perfis] of [['A', ['maker', 'checker', 'leitura', 'gestor']], ['B', ['gestor', 'checker', 'leitura']]]) {
    for (const perfil of perfis) {
      const quem = await R.login(tenant, perfil);
      usuarios.push({ rotulo: quem, tenant, perfil, email: require('../seed-ci-two-tenants').emailFor(tenant, perfil), permissoes: R.claims[quem].permissions });
    }
  }
  const inicio = new Date().toISOString();
  const sfx = String(Date.now()).slice(-7);
  await concederPermissoes(R);
  usuarios.find((u) => u.rotulo === 'A:gestor').permissoes = R.claims['A:gestor'].permissions;
  R.ctx.makerUserId = R.claims['A:maker'].userId;
  await prepararAmbiente(R, sfx);

  const mfa = require('./cenarios-mfa');
  await mfa.semMfaHabilitado(R);
  for (const quem of ['A:gestor', 'A:checker']) await R.habilitarMfa(quem, inTenant);
  await mfa.semVerificacaoRecente(R);
  const verificar = async () => { for (const quem of ['A:gestor', 'A:checker']) await R.verificarMfa(quem, inTenant); };
  R.verificar = verificar;
  await verificar();

  let ultimaVerificacao = Date.now();
  for (const [nome, mod] of ETAPAS) {
    if (SO && !SO.includes(nome)) continue;
    if (Date.now() - ultimaVerificacao > 6 * 60 * 1000) { await verificar(); ultimaVerificacao = Date.now(); }
    if (!fs.existsSync(path.join(__dirname, `${mod.slice(2)}.js`))) { console.error(`[captura] etapa ${nome} ainda não existe`); continue; }
    try {
      await require(mod)(R, { inTenant });
    } catch (err) {
      console.error(`[captura] ETAPA ${nome} INTERROMPIDA: ${err.stack}`);
      R.passos.push({ id: `ERRO-${nome}`, tipo: 'erro', linhas: [], titulo: `etapa ${nome} interrompida`, ok: false, corpo: { erro: err.message } });
    }
  }
  await require('./consultas-banco')(R);

  const [[pg]] = await sequelize.query('select version() as v');
  const [[role]] = await sequelize.query('select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user');
  const sujo = git('status --porcelain -- src scripts/fechamento-m4');
  const doc = {
    meta: {
      gerador: 'scripts/fechamento-m4/capturar.js',
      commit: git('rev-parse HEAD'),
      arvoreDeTrabalho: sujo ? `com alterações não commitadas em: ${sujo.split('\n').map((l) => l.trim()).join('; ')}` : 'limpa (exatamente o commit acima)',
      inicio,
      quando: new Date().toISOString(),
      postgres: pg.v,
      node: process.version,
      roleDaSuite: role,
      ambiente: 'Postgres 16 descartável (cluster local apagado ao final), migrations do zero, seeds do CI e seed de dois tenants; API Express real em processo',
      sanitizacao: [
        'Tokens de acesso/renovação, senhas, segredos TOTP, códigos de recuperação e o segredo do webhook não são gravados ([REDACTED]).',
        'A assinatura HMAC do webhook aparece truncada; o segredo nunca sai da memória.',
        'Corpos de resposta gravados como vieram (campos null preservados), só os valores secretos redigidos.',
        'Usuários fictícios ci-<tenant>-<perfil>@ci.nayaraone.test; a senha existe só no banco descartável.',
        'MFA: habilitado e verificado pela camada de serviço com código TOTP real; nenhum endpoint de MFA chamado por HTTP, nenhum token forjado.',
      ],
      comoReproduzir: 'cd NayaraOne--API && node scripts/withDisposableDb.js --port 5527 -- env LOG_LEVEL=error CI_TENANT_USERS_PASSWORD=<qualquer senha local> CAPTURA_PORT=5528 bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node scripts/fechamento-m4/capturar.js --out <saida.json>"',
    },
    usuarios,
    preparacao: R.preparacao,
    passos: R.passos,
    consultas: R.consultas,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
  const http = R.passos.filter((p) => p.tipo === 'http');
  console.log(`[captura] ${http.length} passos HTTP (${http.filter((p) => p.ok).length} ok, ${http.filter((p) => !p.ok).length} divergentes); ${R.consultas.length} consultas; saída ${OUT}`);
  await sequelize.close();
  process.exit(0);
}

main().catch((err) => { console.error(err.stack); process.exit(1); });
