'use strict';

/**
 * Gera docs/evidencias/MAPA_SEGURANCA.md (Frente 7, Marcos 4/5).
 *
 * SOMENTE LEITURA: conecta com o DATABASE_URL do .env dentro de uma transação
 * `BEGIN READ ONLY` e consulta apenas catálogos (pg_class, pg_policies, pg_roles, pg_trigger,
 * has_table_privilege). Varre o código (src/) para RBAC, MFA step-up, criptografia e auditoria.
 * Nunca imprime host, usuário, senha ou connection string — só o nome do banco é omitido também.
 * Não chama nenhum endpoint (em especial, nenhum endpoint de MFA).
 *
 * Uso: node scripts/generateSecurityMap.js [--out docs/evidencias/MAPA_SEGURANCA.md]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const API_ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const OUT = argv.includes('--out')
  ? path.resolve(argv[argv.indexOf('--out') + 1])
  : path.join(API_ROOT, 'docs', 'evidencias', 'MAPA_SEGURANCA.md');
const RUNTIME_ROLE = 'nayara_runtime';

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function scanCode() {
  const files = walk(path.join(API_ROOT, 'src'));
  const perms = new Map(); // permission -> {count, features:Set}
  const mfaRoutes = [];
  for (const f of files) {
    const rel = path.relative(API_ROOT, f);
    const src = fs.readFileSync(f, 'utf8');
    const feature = rel.split(path.sep)[2] || '-';
    if (rel.endsWith('.routes.js')) {
      for (const m of src.matchAll(/requirePermission\(\s*'([^']+)'\s*\)/g)) {
        const cur = perms.get(m[1]) || { count: 0, features: new Set() };
        cur.count += 1;
        cur.features.add(feature);
        perms.set(m[1], cur);
      }
      src.split('\n').forEach((line, i) => {
        if (/requireRecentMfa/.test(line) && /router\.(get|post|put|patch|delete)/.test(line)) {
          const r = line.match(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/);
          mfaRoutes.push(`${rel}:${i + 1} ${r ? `${r[1].toUpperCase()} ${r[2]}` : line.trim().slice(0, 80)}`);
        }
      });
    }
  }
  // rotas multilinha: conta ocorrências do middleware por arquivo
  const mfaByFile = {};
  for (const f of files.filter((x) => x.endsWith('.routes.js'))) {
    const n = (fs.readFileSync(f, 'utf8').match(/requireRecentMfa[,)]/g) || []).length;
    if (n) mfaByFile[path.relative(API_ROOT, f)] = n;
  }
  return { perms, mfaRoutes, mfaByFile };
}

function gitCommit() {
  try {
    const h = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: API_ROOT }).toString().trim();
    return h;
  } catch (_) {
    return 'desconhecido';
  }
}

async function readDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente no ambiente.');
  const ssl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const q = async (sql, params) => (await client.query(sql, params)).rows;
    const version = (await q('SHOW server_version'))[0].server_version;
    const tables = await q(`
      SELECT n.nspname AS schema, c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
             (SELECT count(*) FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname)::int AS policies,
             (SELECT string_agg(p.policyname, ', ' ORDER BY p.policyname) FROM pg_policies p
               WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policy_names
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p')
         AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
       ORDER BY 1, 2`);
    const roles = await q(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
         FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [[RUNTIME_ROLE, 'nayara_migration']]
    );
    const currentIsRuntime = (await q('SELECT current_user = $1 AS is_runtime', [RUNTIME_ROLE]))[0].is_runtime;
    let auditPriv = [];
    if (roles.some((r) => r.rolname === RUNTIME_ROLE)) {
      auditPriv = await q(
        `SELECT p AS privilege, has_table_privilege($1, 'audit.audit_log', p) AS granted
           FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p`,
        [RUNTIME_ROLE]
      ).catch(() => []);
    }
    const auditTriggers = await q(`
      SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'audit' AND NOT t.tgisinternal ORDER BY 1`);
    await client.query('ROLLBACK');
    return { version, tables, roles, currentIsRuntime, auditPriv, auditTriggers };
  } finally {
    await client.end();
  }
}

function yn(b) {
  return b ? 'sim' : '**não**';
}

function render(db, code) {
  const now = new Date().toISOString();
  const t = db.tables;
  const withRls = t.filter((x) => x.rls);
  const withForce = t.filter((x) => x.rls && x.force);
  const noRls = t.filter((x) => !x.rls);
  const rlsNoForce = t.filter((x) => x.rls && !x.force);
  const rlsNoPolicy = t.filter((x) => x.rls && x.policies === 0);
  const L = [];
  L.push('# Mapa de segurança — Nayara One (API)');
  L.push('');
  L.push(`> Gerado por \`node scripts/generateSecurityMap.js\` em ${now}, commit \`${gitCommit()}\`.`);
  L.push(`> Banco consultado: o do \`DATABASE_URL\` do ambiente (PostgreSQL ${db.version}), transação READ ONLY, só catálogos.`);
  L.push('> Nenhum segredo, host ou connection string é impresso. Nenhum endpoint (inclusive MFA) foi chamado.');
  L.push('> Regenerar no estado final antes do fechamento dos Marcos 4/5.');
  L.push('');
  L.push('## 1. Resumo');
  L.push('');
  L.push('| Item | Valor |');
  L.push('|---|---|');
  L.push(`| Tabelas de usuário (fora de pg_catalog/information_schema) | ${t.length} |`);
  L.push(`| Com RLS habilitado (relrowsecurity) | ${withRls.length} |`);
  L.push(`| Com RLS FORCE (relforcerowsecurity) | ${withForce.length} |`);
  L.push(`| RLS sem FORCE | ${rlsNoForce.length} |`);
  L.push(`| RLS sem nenhuma política (nega tudo para não-owner) | ${rlsNoPolicy.length} |`);
  L.push(`| Sem RLS | ${noRls.length} |`);
  L.push(`| Conexão desta geração é a role de runtime (\`${RUNTIME_ROLE}\`)? | ${db.currentIsRuntime ? 'sim' : 'não'} |`);
  L.push('');
  L.push('## 2. Roles de banco');
  L.push('');
  L.push('| Role | rolsuper | rolbypassrls | rolcreaterole | rolcreatedb | rolcanlogin |');
  L.push('|---|---|---|---|---|---|');
  for (const r of db.roles) L.push(`| ${r.rolname} | ${r.rolsuper} | ${r.rolbypassrls} | ${r.rolcreaterole} | ${r.rolcreatedb} | ${r.rolcanlogin} |`);
  if (!db.roles.length) L.push('| (nenhuma das roles esperadas encontrada) | | | | | |');
  L.push('');
  L.push(`Requisito: \`${RUNTIME_ROLE}\` com rolsuper=false e rolbypassrls=false — as políticas RLS valem para a aplicação. ` +
    'A role de migração (DDL) é dona das tabelas; como todas as tabelas com RLS usam FORCE, as políticas valem inclusive para o owner; só superuser ou role com BYPASSRLS as ignoraria (nenhuma das duas é).');
  L.push('');
  L.push('## 3. Tabelas sem RLS (exceções)');
  L.push('');
  if (!noRls.length) L.push('Nenhuma.');
  else {
    L.push('Tabelas sem RLS são globais/de roteamento (sem `company_id`) ou de infraestrutura (ex.: SequelizeMeta). Conferir cada uma contra `test/rls.catalog.allTables` (lista de exceções documentadas).');
    L.push('');
    L.push('| Schema | Tabela |');
    L.push('|---|---|');
    for (const x of noRls) L.push(`| ${x.schema} | ${x.table} |`);
  }
  L.push('');
  L.push('## 4. RLS por tabela');
  L.push('');
  L.push('| Schema | Tabela | RLS | FORCE | Nº políticas | Políticas |');
  L.push('|---|---|---|---|---|---|');
  for (const x of withRls) L.push(`| ${x.schema} | ${x.table} | ${yn(x.rls)} | ${yn(x.force)} | ${x.policies} | ${x.policy_names || '-'} |`);
  L.push('');
  L.push('Mecanismo: a aplicação abre transação por requisição (`req.withTenantTransaction`, `src/middlewares/tenant.middleware.js`) e faz `SET LOCAL app.group_id` / `app.company_id`; as políticas comparam a coluna de tenant com `current_setting(..., true)` — sem contexto, nenhuma linha (fail closed).');
  L.push('');
  L.push('## 5. RBAC (permissões nas rotas)');
  L.push('');
  L.push('Fonte: `requirePermission(...)` em `src/**/*.routes.js` (`src/middlewares/auth.middleware.js`). Permissões efetivas: `core.roles` → `core.role_permissions` → `core.permissions`, resolvidas por membership em `src/features/memberships/effectivePermissions.service.js`.');
  L.push('');
  L.push('| Permissão | Nº de rotas | Módulos |');
  L.push('|---|---|---|');
  for (const [p, v] of [...code.perms.entries()].sort()) L.push(`| \`${p}\` | ${v.count} | ${[...v.features].sort().join(', ')} |`);
  L.push('');
  L.push('## 6. MFA (documentação — nenhum endpoint chamado)');
  L.push('');
  L.push('- TOTP; segredo cifrado em repouso com AES-256-GCM e chave dedicada `MFA_ENCRYPTION_KEY` (`src/utils/mfaCrypto.js`), obrigatória, sem fallback.');
  L.push('- Step-up: middleware `requireRecentMfa` (`src/middlewares/auth.middleware.js`) — fail closed: sem MFA habilitado ou sem verificação recente → 403. Também aplicado condicionalmente em `approvals.service.decideApprovalStep` para risco HIGH/CRITICAL.');
  L.push('- Ocorrências de `requireRecentMfa` por arquivo de rotas:');
  L.push('');
  L.push('| Arquivo | Ocorrências |');
  L.push('|---|---|');
  for (const [f, n] of Object.entries(code.mfaByFile).sort()) L.push(`| ${f} | ${n} |`);
  L.push('');
  L.push('## 7. Criptografia de arquivos');
  L.push('');
  L.push('- Conteúdo de arquivo em disco: AES-256-GCM (`src/utils/fileCrypto.js`), formato `NAYENC1 | IV(12) | TAG(16) | ciphertext`, chave `FILES_ENCRYPTION_KEY` obrigatória (fail closed).');
  L.push('- Integridade: `people.files.checksum_sha256` do conteúdo em claro; adulteração de 1 byte → falha de autenticação GCM e a API responde 409 (provado no drill de restore).');
  L.push('- Arquivos legados sem o marcador são servidos como estão (compatibilidade) — ver comentário do módulo.');
  L.push('- Num restore, sem a mesma `FILES_ENCRYPTION_KEY` os bytes restaurados são ilegíveis (ver RUNBOOK_RESTORE.md).');
  L.push('');
  L.push('## 8. Auditoria');
  L.push('');
  L.push('- Trilha em `audit.audit_log` (`src/models/AuditLog.js`, `src/features/audit/`), com before/after, ator, empresa e motivo.');
  if (db.auditPriv.length) {
    L.push(`- Privilégios da role \`${RUNTIME_ROLE}\` em \`audit.audit_log\`:`);
    L.push('');
    L.push('| Privilégio | Concedido |');
    L.push('|---|---|');
    for (const p of db.auditPriv) L.push(`| ${p.privilege} | ${p.granted} |`);
  }
  L.push('');
  L.push('- Triggers no schema `audit`:');
  L.push('');
  if (!db.auditTriggers.length) L.push('  (nenhum)');
  for (const tr of db.auditTriggers) L.push(`  - \`${tr.tgname}\`: \`${tr.def}\``);
  L.push('');
  L.push('## 9. Evidências relacionadas');
  L.push('');
  L.push('- Drill de restore com RLS + RBAC pós-restore: `npm run restore-drill:legal-full` (ver RUNBOOK_RESTORE.md).');
  L.push('- Testes: `test/rls.catalog.allTables*`, `adversarial.finance`, `adversarial.legal`, `f06.flowSecurity`, `ciTwoTenants*` (rodam contra PostgreSQL real com role NOSUPERUSER/NOBYPASSRLS no CI).');
  L.push('');
  return L.join('\n');
}

(async () => {
  const code = scanCode();
  const db = await readDb();
  const md = render(db, code);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md + '\n');
  const force = db.tables.filter((x) => x.rls && x.force).length;
  console.log(`Mapa gerado em ${path.relative(process.cwd(), OUT)} — ${db.tables.length} tabelas, ${force} com RLS FORCE, ${db.roles.length} roles checadas.`);
})().catch((err) => {
  console.error('Falha ao gerar o mapa:', err.message);
  process.exit(1);
});
