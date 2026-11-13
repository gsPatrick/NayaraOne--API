'use strict';

/**
 * M4-D140 — Guia do Marco 4, §2 "Estrutura de pastas": o Financeiro mora em src/modules/finance (domain,
 * application/services, infrastructure/{repositories,bank,db/migrations}, presentation/http, workers), sem o
 * caminho antigo, sem reexport, com o domínio puro, a direção das dependências respeitada, o acesso a dados dos
 * cinco agregados nos repositórios, as migrations financeiras na pasta do módulo com os nomes de antes, o mesmo
 * schema, a SequelizeMeta consistente e as mesmas rotas, permissões e MFA (retratos em test/fixtures/m4d140-*).
 * Os testes 9 e 10 migram um banco vazio NOVO (criado e apagado aqui) com a credencial de administrador do banco
 * descartável (DATABASE_ADMIN_URL, scripts/withDisposableDb.js) ou do CI (M4D140_ADMIN_URL).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { isFinanceMigration } = require('../scripts/lib/financeMigrations');
const { mapaDeRotasDoFinanceiro } = require('../scripts/lib/financeRoutesMap');
const { fingerprint } = require('../scripts/lib/schemaFingerprint');
const { inventario } = require('../scripts/lib/testInventory');
const { ROOT_MIGRATIONS_DIR, FINANCE_MIGRATIONS_DIR, listMigrationFiles } = require('../src/config/migrationDirs');

const API = path.resolve(__dirname, '..');
const MOD = path.join(API, 'src', 'modules', 'finance');
const rel = (abs) => path.relative(API, abs).split(path.sep).join('/');
// Montado por concatenação para o próprio teste não citar o caminho antigo.
const ANTIGO = ['src', 'features', 'fin' + 'ance'].join('/');
const CITA_ANTIGO = new RegExp(`features[\\\\/]fin${'ance'}(?![\\w-])|['"]features['"]\\s*,\\s*['"]fin${'ance'}['"]`);

function falha(codigo, mensagem) {
  return `${codigo}: ${mensagem}`;
}

function arquivosJs(dir, { comMigrations = false } = {}) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!comMigrations && abs === FINANCE_MIGRATIONS_DIR) continue;
      out.push(...arquivosJs(abs, { comMigrations }));
    } else if (e.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

function semComentarios(fonte) {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function requiresDe(fonte) {
  return [...semComentarios(fonte).matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

function camadaDe(abs) {
  if (!abs.startsWith(MOD + path.sep)) return null;
  return path.relative(MOD, abs).split(path.sep)[0];
}

function resolver(deArquivo, spec) {
  if (!spec.startsWith('.')) return null;
  return require.resolve(path.resolve(path.dirname(deArquivo), spec));
}

// --- 1 a 6: estrutura do código -------------------------------------------------------------------

test('m4d140_caminho_antigo_nao_existe', () => {
  let existe = true;
  try { fs.lstatSync(path.join(API, ANTIGO)); } catch (_e) { existe = false; }
  assert.equal(existe, false, falha('ESTRUTURA_CAMINHO_ANTIGO_EXISTE', 'O módulo financeiro deve ficar em src/modules/finance; o caminho antigo não pode existir.'));
});

// Evidência já capturada (log de execução e dados brutos da entrega) não se altera: estes arquivos citam o caminho
// que valia quando foram gravados. Ficam fora da busca pelo hash exato — se alguém mexer neles, o teste reprova.
const EVIDENCIA_CAPTURADA = {
  'docs/entrega-marco45/antes-46b0ecb-test-results.log': '2b840b363a38bea315bf78712ca53366b6f1f211b10360df494c70bd22cc6ec4',
  'docs/entrega-marco45/base.json': '2db9760da31a69ac3e5f8d9eb77b90843def81ca1fc2894b289d042a8f561e88',
  'docs/evidencias/ci/esteira-financeiro.log': '9d1818033ba639a21ae81806c26bb5c9c3133df504eea5a9bd78d7172efaf031',
  'docs/evidencias/ci/esteira-financeiro-2.log': '9158d2d42b954f56439d66e67952d2ba89967c769285a912e82f8de08380895a',
};

function arquivosVersionados() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: API, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch (_e) {
    const out = [];
    const andar = (dir) => {
      for (const e of fs.readdirSync(path.join(API, dir), { withFileTypes: true })) {
        if (['node_modules', '.git', 'uploads', 'backups'].includes(e.name)) continue;
        const r = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) andar(r); else out.push(r);
      }
    };
    andar('');
    return out;
  }
}

test('m4d140_nenhum_arquivo_cita_o_caminho_antigo', () => {
  const citam = [];
  for (const f of arquivosVersionados()) {
    if (/^(node_modules|uploads|backups)\//.test(f) || !fs.existsSync(path.join(API, f))) continue;
    const buf = fs.readFileSync(path.join(API, f));
    if (buf.includes(0)) continue; // binário
    if (Object.prototype.hasOwnProperty.call(EVIDENCIA_CAPTURADA, f)) {
      assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), EVIDENCIA_CAPTURADA[f], `evidência capturada alterada: ${f}`);
      continue;
    }
    if (CITA_ANTIGO.test(buf.toString('utf8'))) citam.push(f);
  }
  assert.deepEqual(citam, [], citam.map((f) => falha('ESTRUTURA_REFERENCIA_AO_CAMINHO_ANTIGO', `Há referência ao caminho antigo do módulo financeiro em ${f}.`)).join('\n'));
});

const CAMINHOS_DO_GUIA = [
  'domain/financial-entry.js', 'domain/ledger-movement.js', 'domain/payment-intent.js', 'domain/reconciliation.js', 'domain/commission.js',
  'application/services/financial-entry.service.js', 'application/services/payment.service.js', 'application/services/receipt.service.js',
  'application/services/reconciliation.service.js', 'application/services/commission.service.js', 'application/services/closing.service.js',
  'application/services/finance-health.service.js',
  'infrastructure/repositories/', 'infrastructure/bank/bank-adapter.port.js', 'infrastructure/bank/providers/', 'infrastructure/db/migrations/',
  'presentation/http/', 'workers/bank-import.worker.js', 'workers/reconciliation.worker.js',
  // regra 4: um repositório por agregado do Guia
  'infrastructure/repositories/financial-entry.repository.js', 'infrastructure/repositories/ledger-movement.repository.js',
  'infrastructure/repositories/payment-intent.repository.js', 'infrastructure/repositories/reconciliation.repository.js',
  'infrastructure/repositories/commission.repository.js',
];

test('m4d140_cada_caminho_do_guia_existe_e_nao_esta_vazio', () => {
  const faltam = [];
  for (const item of CAMINHOS_DO_GUIA) {
    const abs = path.join(MOD, item);
    if (item.endsWith('/')) {
      const ok = fs.existsSync(abs) && fs.statSync(abs).isDirectory() && fs.readdirSync(abs).some((n) => n.endsWith('.js'));
      if (!ok) faltam.push(item);
    } else if (!fs.existsSync(abs) || semComentarios(fs.readFileSync(abs, 'utf8')).replace(/['"]use strict['"];?/, '').trim() === '') {
      faltam.push(item);
    }
  }
  assert.deepEqual(faltam, [], faltam.map((c) => falha('ESTRUTURA_CAMINHO_DO_GUIA_AUSENTE', `Falta o arquivo exigido pelo Guia §2: src/modules/finance/${c}.`)).join('\n'));
});

/** Só reexport: depois de tirar comentários, 'use strict' e os `const x = require(...)`, sobra apenas um module.exports sem código próprio. */
function apenasReexport(fonte) {
  let resto = semComentarios(fonte).replace(/['"]use strict['"];?/, '');
  resto = resto.replace(/(?:const|let|var)\s+[^=;]+=\s*require\([^)]*\)(?:\.[\w$]+)*\s*;?/g, '').trim();
  const m = /^module\.exports\s*=\s*([\s\S]*?);?\s*$/.exec(resto);
  if (!m) return false;
  return !/function\b|=>|\bclass\b|\bnew\b|\(/.test(m[1].replace(/require\([^)]*\)/g, ''));
}

test('m4d140_nenhum_arquivo_e_apenas_reexport', () => {
  const problemas = [];
  const hashes = new Map();
  for (const abs of arquivosJs(path.join(API, 'src'), { comMigrations: true })) {
    const conteudo = fs.readFileSync(abs);
    const h = crypto.createHash('sha256').update(conteudo).digest('hex');
    if (!hashes.has(h)) hashes.set(h, []);
    hashes.get(h).push(rel(abs));
  }
  const andar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (fs.lstatSync(abs).isSymbolicLink()) problemas.push(`symlink: ${rel(abs)}`);
      else if (e.isDirectory()) andar(abs);
      else if (e.name.endsWith('.js')) {
        const conteudo = fs.readFileSync(abs, 'utf8');
        if (apenasReexport(conteudo)) problemas.push(falha('ESTRUTURA_REEXPORT_PROIBIDO', `Reexport não é permitido: ${rel(abs)}.`));
        const iguais = hashes.get(crypto.createHash('sha256').update(conteudo).digest('hex')) || [];
        if (iguais.length > 1) problemas.push(`cópia: ${iguais.join(' = ')}`);
      }
    }
  };
  andar(MOD);
  assert.deepEqual(problemas, [], problemas.join('\n'));
  // O detector funciona: um arquivo que só reexporta é reconhecido; um com código próprio, não.
  assert.equal(apenasReexport("'use strict';\nmodule.exports = require('./outro');\n"), true);
  assert.equal(apenasReexport("'use strict';\nconst a = require('./a');\nmodule.exports = { ...a, ...require('./b') };\n"), true);
  assert.equal(apenasReexport("'use strict';\nconst a = require('./a');\nfunction f() { return a.x(); }\nmodule.exports = { f };\n"), false);
});

const DOMINIO_PROIBE = /^(sequelize|pg|pg-.*|express|fs|node:fs|dotenv)$|models|AppError|middlewares|engines/;

test('m4d140_dominio_nao_importa_banco_http_nem_ambiente', () => {
  const problemas = [];
  for (const abs of arquivosJs(path.join(MOD, 'domain'))) {
    const fonte = fs.readFileSync(abs, 'utf8');
    if (/process\.env/.test(semComentarios(fonte))) problemas.push(`${rel(abs)} lê process.env`);
    for (const spec of requiresDe(fonte)) {
      const destino = resolver(abs, spec);
      const dentroDoDominio = destino && camadaDe(destino) === 'domain';
      if (DOMINIO_PROIBE.test(spec) || !(dentroDoDominio || spec === 'node:crypto' || spec === 'crypto')) problemas.push(`${rel(abs)} importa ${spec}`);
    }
  }
  assert.deepEqual(problemas, [], [falha('ESTRUTURA_DOMINIO_IMPURO', 'O domínio não pode depender de banco, HTTP ou ambiente.'), ...problemas].join('\n'));
});

// Para cada camada de origem, as camadas do módulo que ela pode importar (regra 5).
const PODE_IMPORTAR = {
  domain: ['domain'],
  application: ['domain', 'application', 'infrastructure'],
  infrastructure: ['domain', 'infrastructure'],
  presentation: ['application', 'presentation'],
  workers: ['application', 'workers'],
};

test('m4d140_direcao_das_dependencias_entre_camadas', () => {
  const problemas = [];
  for (const abs of arquivosJs(MOD)) {
    const origem = camadaDe(abs);
    assert.ok(PODE_IMPORTAR[origem], `arquivo fora das camadas do Guia: ${rel(abs)}`);
    for (const spec of requiresDe(fs.readFileSync(abs, 'utf8'))) {
      const destino = resolver(abs, spec);
      const camada = destino && camadaDe(destino);
      if (camada && !PODE_IMPORTAR[origem].includes(camada)) problemas.push(`${rel(abs)} (${origem}) importa ${rel(destino)} (${camada})`);
    }
  }
  assert.deepEqual(problemas, [], problemas.join('\n'));
});

// Os cinco serviços do Guia (e os arquivos de apoio em que eles foram divididos) só acessam dados pelos repositórios.
const SERVICOS_DO_GUIA = [
  'financial-entry.service.js', 'payment.service.js', 'receipt.service.js', 'reconciliation.service.js', 'commission.service.js',
  'commission-installments.service.js', 'bank-submission.service.js', 'settlement-gates.js', 'settlement-evidence.service.js',
  'classification-pending.service.js', 'ledger-balance.service.js', 'third-party-funds.service.js', 'payment-intent-invalidation.js',
];
const METODO_DE_MODELO = /\b([A-Za-z_$][\w$]*)\s*\.\s*(findAll|findOne|findByPk|findOrCreate|findAndCountAll|create|bulkCreate|update|destroy|save|reload|count|sum|max|min|increment|decrement|upsert)\s*\(/g;

function violacoesDeAcessoADados(fonte) {
  const codigo = semComentarios(fonte);
  const repositorios = new Set([...codigo.matchAll(/(?:const|let)\s+([\w$]+)\s*=\s*require\(\s*['"][^'"]*infrastructure\/repositories\/[^'"]+['"]\s*\)/g)].map((m) => m[1]));
  const v = [];
  if (/sequelize\s*\.\s*query\s*\(/.test(codigo)) v.push('sequelize.query(');
  for (const spec of requiresDe(fonte)) if (spec === 'sequelize' || /(^|\/)models(\/index)?$/.test(spec)) v.push(`require('${spec}')`);
  for (const m of codigo.matchAll(METODO_DE_MODELO)) if (!repositorios.has(m[1])) v.push(`${m[1]}.${m[2]}(`);
  return v;
}

test('m4d140_cinco_servicos_do_guia_sem_sql_nem_modelo_direto', () => {
  const problemas = [];
  for (const nome of SERVICOS_DO_GUIA) {
    const abs = path.join(MOD, 'application', 'services', nome);
    for (const v of violacoesDeAcessoADados(fs.readFileSync(abs, 'utf8'))) problemas.push(`${nome}: ${v}`);
  }
  assert.deepEqual(problemas, [], problemas.join('\n'));
  // O detector pega o que a regra proíbe e aceita a chamada ao repositório.
  assert.deepEqual(violacoesDeAcessoADados("const { X } = require('../../../../models');\nawait X.findOne({});\nawait sequelize.query('x');"), ['sequelize.query(', "require('../../../../models')", 'X.findOne(']);
  assert.deepEqual(violacoesDeAcessoADados("const repo = require('../../infrastructure/repositories/x.repository');\nawait repo.save(i, t);"), []);
});

// --- 8 a 10: migrations -----------------------------------------------------------------------------

const SNAPSHOT_META = require('./fixtures/m4d140-sequelize-meta-financeiro.json');

test('m4d140_migrations_financeiras_fora_da_raiz_e_nomes_intactos', () => {
  const naRaiz = fs.readdirSync(ROOT_MIGRATIONS_DIR).filter((f) => f.endsWith('.js') && isFinanceMigration(fs.readFileSync(path.join(ROOT_MIGRATIONS_DIR, f), 'utf8')));
  assert.deepEqual(naRaiz, [], `migration financeira na pasta raiz migrations/: ${naRaiz.join(', ')}`);
  const doModulo = fs.readdirSync(FINANCE_MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort();
  // Nomes intactos: cada migration financeira do retrato de antes está na pasta do módulo com o MESMO nome (a SequelizeMeta
  // guarda o nome). Migration financeira nova de outra demanda entra nesta pasta depois do retrato.
  const sumidas = SNAPSHOT_META.nomes.filter((n) => !doModulo.includes(n));
  assert.deepEqual(sumidas, [], `migrations financeiras do retrato fora da pasta do módulo (renomeadas ou apagadas): ${sumidas.join(', ')}`);
  assert.equal(SNAPSHOT_META.nomes.length, SNAPSHOT_META.total);
  for (const f of doModulo) assert.equal(isFinanceMigration(fs.readFileSync(path.join(FINANCE_MIGRATIONS_DIR, f), 'utf8')), true, `${f} não é financeira`);
  const nomes = listMigrationFiles().map((m) => m.name);
  assert.equal(new Set(nomes).size, nomes.length, 'nome de migration repetido entre as duas pastas');
});

const ADMIN_URL = process.env.DATABASE_ADMIN_URL || process.env.M4D140_ADMIN_URL;
const SUFIXO = `${process.pid}_${Date.now().toString(36)}`;
// Dois bancos vazios: um migrado pelo executor (duas pastas) e outro pela organização antiga (todas as migrations numa pasta só).
const banco = { nome: `m4d140_vazio_${SUFIXO}`, nomeAntigo: `m4d140_pasta_unica_${SUFIXO}`, criouRole: false };

function urlDo(nome) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${nome}`;
  return u.toString();
}

async function comCliente(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

function envDo(nome) {
  const env = { ...process.env, DATABASE_URL: urlDo(nome), NODE_ENV: 'development', DB_SSL: 'false', LOG_LEVEL: 'silent' };
  for (const k of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_MIGRATION_USER', 'DB_MIGRATION_PASSWORD']) delete env[k];
  return env;
}

function executor(args) {
  return execFileSync(process.execPath, [path.join(API, 'scripts', 'migrate.js'), ...args], { cwd: API, env: envDo(banco.nome), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Organização de antes da mudança: todas as migrations numa pasta só (links, fora do repositório), pelo sequelize-cli puro. */
function migrarComPastaUnica() {
  const pasta = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'm4d140-pasta-unica-'));
  try {
    for (const m of listMigrationFiles()) fs.symlinkSync(m.file, path.join(pasta, m.name));
    const bin = require.resolve('sequelize-cli/lib/sequelize');
    return execFileSync(process.execPath, [bin, 'db:migrate', '--migrations-path', pasta], { cwd: API, env: envDo(banco.nomeAntigo), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

const impressaoDo = (nome) => comCliente(urlDo(nome), (c) => fingerprint(async (sql) => (await c.query(sql)).rows));

before(async () => {
  if (!ADMIN_URL) return;
  await comCliente(ADMIN_URL, async (c) => {
    // Os GRANTs das migrations só valem com o role de runtime existente (guarda de existência): no CI ele não existe.
    const { rowCount } = await c.query("SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime'");
    if (!rowCount) {
      await c.query('CREATE ROLE nayara_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS');
      banco.criouRole = true;
    }
    await c.query(`CREATE DATABASE ${banco.nome}`);
    await c.query(`CREATE DATABASE ${banco.nomeAntigo}`);
  });
  banco.criado = true;
  banco.saidaUp = executor(['up']);
  banco.saidaStatus = executor(['status']);
  banco.saidaAntiga = migrarComPastaUnica();
  banco.impressao = await impressaoDo(banco.nome);
  banco.impressaoAntiga = await impressaoDo(banco.nomeAntigo);
  banco.meta = await comCliente(urlDo(banco.nome), async (c) => (await c.query('SELECT name FROM "SequelizeMeta" ORDER BY name')).rows.map((r) => r.name));
  banco.metaDaSuite = await comCliente(ADMIN_URL, async (c) => (await c.query('SELECT name FROM "SequelizeMeta" ORDER BY name')).rows.map((r) => r.name));
});

after(async () => {
  if (banco.criado) {
    await comCliente(ADMIN_URL, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${banco.nome} WITH (FORCE)`);
      await c.query(`DROP DATABASE IF EXISTS ${banco.nomeAntigo} WITH (FORCE)`);
    });
  }
  if (banco.criouRole) await comCliente(ADMIN_URL, (c) => c.query('DROP ROLE IF EXISTS nayara_runtime'));
  await require('../src/models').sequelize.close().catch(() => {});
});

const SEM_ADMIN = 'precisa da credencial de administrador do banco de teste (DATABASE_ADMIN_URL do banco descartável ou M4D140_ADMIN_URL no CI) para criar o banco vazio';

test('m4d140_migrate_em_banco_vazio_gera_o_mesmo_schema', () => {
  assert.ok(ADMIN_URL, SEM_ADMIN);
  const arquivos = listMigrationFiles();
  assert.equal((banco.saidaUp.match(/: migrated \(/g) || []).length, arquivos.length, 'o executor não aplicou todas as migrations das duas pastas');
  assert.equal((banco.saidaAntiga.match(/: migrated \(/g) || []).length, arquivos.length, 'a pasta única não aplicou todas as migrations');
  const comparar = (esperado, rotulo) => {
    const diferentes = Object.keys(esperado.categorias).filter((k) => esperado.categorias[k].sha256 !== banco.impressao.categorias[k].sha256);
    assert.deepEqual(diferentes, [], `schema diferente ${rotulo} em: ${diferentes.join(', ')}`);
    assert.equal(banco.impressao.sha256, esperado.sha256);
  };
  // Sempre: as duas pastas pelo executor geram o mesmo schema que a organização antiga (uma pasta só) com as mesmas migrations.
  comparar(banco.impressaoAntiga, 'da organização antiga (todas as migrations numa pasta só)');
  // E, com o mesmo conjunto de migrations do commit base, o mesmo schema do retrato tirado lá (antes da mudança).
  const antes = require('./fixtures/m4d140-schema-antes.json');
  if (banco.impressao.categorias.sequelizeMeta.sha256 === antes.categorias.sequelizeMeta.sha256) comparar(antes, `do retrato de antes (commit ${antes.geradoNoCommit})`);
});

test('m4d140_migrate_status_sem_pendentes_e_sem_arquivo_ausente', () => {
  assert.ok(ADMIN_URL, SEM_ADMIN);
  const nomes = listMigrationFiles().map((m) => m.name);
  assert.equal((banco.saidaStatus.match(/^up /gm) || []).length, nomes.length, 'status: nem todas as migrations aparecem aplicadas');
  assert.equal((banco.saidaStatus.match(/^down /gm) || []).length, 0, 'status: há migration pendente');
  assert.deepEqual(banco.meta, [...nomes].sort(), 'banco novo: SequelizeMeta difere dos arquivos');
  // O banco da bateria (migrado antes dos testes) também: nenhuma pendente e nenhuma linha sem arquivo.
  const semArquivo = banco.metaDaSuite.filter((n) => !nomes.includes(n));
  const pendentes = nomes.filter((n) => !banco.metaDaSuite.includes(n));
  assert.deepEqual({ semArquivo, pendentes }, { semArquivo: [], pendentes: [] });
  for (const n of SNAPSHOT_META.nomes) assert.ok(banco.metaDaSuite.includes(n), `migration financeira sem linha na SequelizeMeta: ${n}`);
});

// --- 11 a 15: rotas, workers, bateria, scripts e varreduras ------------------------------------------

test('m4d140_rotas_http_e_permissoes_identicas_ao_snapshot', () => {
  const antes = require('./fixtures/m4d140-rotas-http.json');
  const agora = mapaDeRotasDoFinanceiro();
  assert.equal(agora.length, antes.total);
  assert.deepEqual(agora, antes.rotas, falha('ESTRUTURA_ROTAS_ALTERADAS', 'O mapa de rotas HTTP mudou na reorganização.'));
});

test('m4d140_workers_exportam_pontos_de_entrada', async () => {
  const { runBankImport } = require('../src/modules/finance/workers/bank-import.worker');
  const { runReconciliation } = require('../src/modules/finance/workers/reconciliation.worker');
  const hub = require('../src/modules/finance/application/services/bank-hub');
  assert.equal(typeof runBankImport, 'function');
  assert.equal(typeof runReconciliation, 'function');
  const chamadas = [];
  const originais = { sweepStatements: hub.sweepStatements, reconcileStatements: hub.reconcileStatements };
  hub.sweepStatements = async (ctx) => { chamadas.push(['importacao', ctx]); return { imported: 3 }; };
  hub.reconcileStatements = async (ctx) => { chamadas.push(['conciliacao', ctx]); return { reconciled: 2, mismatched: 0 }; };
  try {
    const ctx = { group: { id: 'g' }, company: { id: 'c' } };
    assert.deepEqual(await runBankImport(ctx), { imported: 3 });
    assert.deepEqual(await runReconciliation(ctx), { reconciled: 2, mismatched: 0 });
    assert.deepEqual(chamadas.map(([o, c]) => [o, c.group.id, c.company.id]), [['importacao', 'g', 'c'], ['conciliacao', 'g', 'c']]);
    await assert.rejects(runBankImport({}), /informe o grupo e a empresa/);
  } finally {
    Object.assign(hub, originais);
  }
  // O job real chama os dois workers.
  const job = fs.readFileSync(path.join(API, 'src', 'engines', 'jobs', 'bankPaymentReconciliationJob.js'), 'utf8');
  assert.match(job, /runBankImport\(\{ group, company \}\)/);
  assert.match(job, /runReconciliation\(\{ group, company \}\)/);
});

test('m4d140_bateria_completa_mesmos_totais_antes_e_depois', () => {
  const antes = require('./fixtures/m4d140-bateria-antes.json');
  const agora = inventario(API);
  const perdidos = [];
  for (const [arquivo, a] of Object.entries(antes.porArquivo)) {
    const d = agora.porArquivo[arquivo];
    if (!d) perdidos.push(`${arquivo}: saiu da bateria`);
    else if (d.testes < a.testes) perdidos.push(`${arquivo}: ${a.testes} -> ${d.testes} testes`);
    else if (d.ignorados > a.ignorados) perdidos.push(`${arquivo}: marcas de ignorado ${a.ignorados} -> ${d.ignorados}`);
  }
  assert.deepEqual(perdidos, [], perdidos.join('\n'));
  const novos = Object.keys(agora.porArquivo).filter((f) => !antes.porArquivo[f]);
  assert.ok(novos.includes('test/m4d140.estruturaFinanceiro.test.js'), 'o teste desta demanda roda no npm test');
  const deste = agora.porArquivo['test/m4d140.estruturaFinanceiro.test.js'];
  assert.equal(deste.ignorados, 0, 'teste novo ignorado');
  assert.ok(agora.declaracoes >= antes.declaracoes + 15, `declarações: antes ${antes.declaracoes}, agora ${agora.declaracoes}`);
});

const SCRIPTS_DE_SEED_E_RESTORE = [
  'scripts/seed-dev.js', 'scripts/seed-homo-m45.js', 'scripts/seed-homo-m45-repasse.js', 'scripts/m45-sanitizeRuleViolations.js',
  'scripts/seedFinanceAntifraudRules.js', 'scripts/restoreDrill/seedLegalFixtures.js', 'scripts/restoreDrill/seedFinanceFixtures.js',
  'scripts/restoreDrill/replayFinanceRestore.js', 'scripts/restoreDrill/verifyFinanceRestore.js', 'scripts/generateSecurityMap.js',
];

test('m4d140_scripts_de_seed_e_restore_executam_no_caminho_novo', () => {
  const problemas = [];
  for (const r of SCRIPTS_DE_SEED_E_RESTORE) {
    const abs = path.join(API, r);
    if (!fs.existsSync(abs)) { problemas.push(`${r} não existe`); continue; }
    execFileSync(process.execPath, ['--check', abs]);
    for (const spec of requiresDe(fs.readFileSync(abs, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      try { resolver(abs, spec); } catch (_e) { problemas.push(`${r}: require('${spec}') não resolve`); }
    }
  }
  assert.deepEqual(problemas, [], problemas.join('\n'));
  // Os módulos do Financeiro que os scripts de seed e restore usam carregam do caminho novo (sem abrir banco).
  for (const m of ['financial-entry.service', 'receipt.service', 'payment.service', 'bank-submission.service', 'commission.service', 'closing.service']) {
    assert.equal(typeof require(path.join(MOD, 'application', 'services', m)), 'object', m);
  }
  const mapa = fs.readFileSync(path.join(API, 'docs', 'evidencias', 'MAPA_SEGURANCA.md'), 'utf8');
  assert.match(mapa, /src\/modules\/finance\/presentation\/http\/finance\.routes\.js/, 'o mapa de segurança foi regenerado no caminho novo');
});

test('m4d140_lint_baseline_e_scanners_usam_caminhos_novos', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(API, 'scripts', 'lint-baseline.json'), 'utf8'));
  for (const chave of Object.keys(baseline)) assert.ok(fs.existsSync(path.join(API, chave)), `lint-baseline: ${chave} não existe`);
  // Varreduras que percorrem o Financeiro olham a pasta nova.
  for (const r of ['scripts/financeiro/ci/typecheck.js', 'scripts/lib/naoImprovisar/guard6.financeiro.js', 'scripts/check-file-size.js']) {
    assert.match(fs.readFileSync(path.join(API, r), 'utf8'), /src\/modules\/finance/, r);
  }
  const { scan } = require('../scripts/lib/naoImprovisar/guard6.financeiro');
  assert.deepEqual(scan(), []);
  // Sem god file no módulo (máximo de 400 linhas por arquivo, como o guarda do Marco 9).
  const grandes = arquivosJs(MOD).filter((abs) => fs.readFileSync(abs, 'utf8').replace(/\n$/, '').split('\n').length > 400).map(rel);
  assert.deepEqual(grandes, [], `arquivos acima de 400 linhas: ${grandes.join(', ')}`);
  // Esteira do Financeiro (estágio 4) confere as migrations das duas pastas; o CI da suíte dá ao teste 9 a credencial do banco
  // de teste; a imagem migra pelo executor (npm run migrate).
  assert.match(fs.readFileSync(path.join(API, 'scripts', 'financeiro', 'ci', 'estagio4Migracoes.js'), 'utf8'), /listMigrationFiles\(\)/);
  assert.match(fs.readFileSync(path.join(API, '.github', 'workflows', 'test.yml'), 'utf8'), /M4D140_ADMIN_URL:/);
  assert.match(fs.readFileSync(path.join(API, 'Dockerfile'), 'utf8'), /npm run migrate/);
  const pkg = JSON.parse(fs.readFileSync(path.join(API, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.migrate, 'node scripts/migrate.js up');
  assert.match(fs.readFileSync(path.join(API, '.sequelizerc'), 'utf8'), /installMultiDirMigrations/);
});
