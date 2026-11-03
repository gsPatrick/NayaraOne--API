# Security scan (SAST + dependências)

Caderno Técnico, página 165, item 13 ("segurança/antifraude do módulo de Obras") — a auditora
externa da Nayara pediu evidência de "security scan e load/failure tests" para o Marco 6. Este
documento cobre a parte de **security scan** (load/failure tests estão em
`test/construction.failureDrills.test.js`).

## 1. Scan de dependências (`npm audit`)

### Script

`scripts/securityScan.js` roda `npm audit --omit=dev --json` via `child_process.execFile`
(nunca string de shell interpolada — ver SAST abaixo), parseia o resultado e falha
(`process.exitCode = 1`) se existir qualquer vulnerabilidade **high** ou **critical** nas
dependências de produção. Vulnerabilidades **moderate**/**low** aparecem no log como warning,
mas não bloqueiam o build.

**Decisão documentada:** o scanner bloqueia em HIGH/CRITICAL **independente de já existir fix
disponível** — a presença de um fix não torna a vulnerabilidade menos real enquanto ele não foi
aplicado. Isso é mais rígido que "só bloquear se não houver fix", e foi a escolha deliberada
para este repositório (ver comentário no topo de `scripts/securityScan.js`).

Rodar localmente:

```bash
node scripts/securityScan.js
```

Integrado ao CI em `.github/workflows/test.yml` (step "Security scan (npm audit — dependências
de produção)"), depois do `npm ci` e do scanner de hard-code já existente.

### Resultado REAL rodado em 08/10/2026 (`npm audit --omit=dev --json`, commit `1208c88`)

Contagem por severidade (`metadata.vulnerabilities` do JSON real):

```json
{
  "info": 0,
  "low": 0,
  "moderate": 3,
  "high": 1,
  "critical": 1,
  "total": 5
}
```

Pacotes afetados (5 advisories agrupados em 5 pacotes):

| Pacote | Severidade | Advisory | Fix disponível |
|---|---|---|---|
| `brace-expansion` | **high** | DoS por recursão/expansão quadrática (GHSA-qhr7-859c-m2p7 / GHSA-6j4f-fj2g-mc7p / GHSA-q2hr-2g5m-vwhr) | Sim, `npm audit fix` (não-major) |
| `proxy-addr` | **critical** | IP spoofing via IPv4-mapped IPv6 trust subnet (GHSA-jqcg-44mw-7w3h) | Sim, `npm audit fix` (não-major) |
| `moment` | moderate | Path Traversal via locale name (GHSA-4p3w-j4w9-5jqw) | Sim, `npm audit fix` (não-major) |
| `sequelize` | moderate | via dependência transitiva `uuid` | Só via downgrade major (`sequelize@3.30.0`) |
| `uuid` | moderate | Missing buffer bounds check em v3/v5/v6 (GHSA-w5hq-g745-h8pq) | Só via upgrade major de `sequelize` |

**Status no momento desta auditoria:** com este scanner integrado ao CI, o step
"Security scan" **falha de verdade** (não é um gap escondido) — `brace-expansion` e
`proxy-addr` têm fix não-major disponível e devem ser corrigidos rodando `npm audit fix` (sem
`--force`) antes do próximo merge; isso não foi aplicado nesta sessão porque alterar
`package-lock.json`/`node_modules` está fora do escopo de permissão desta tarefa (ambiente
sandboxed trata isso como modificação de recurso compartilhado). `sequelize`/`uuid` exigem
downgrade major (`sequelize@3.30.0`) — tratado como item de hardening futuro separado, não
escondido, por mexer em uma dependência central do projeto e precisar de regressão própria.

## 2. SAST simples (`src/`)

### Script

`scripts/sastScan.js` varre todo `src/**/*.js` (exclui `test/` e `*.test.js`) com 4 padrões de
regex conhecidos como perigosos:

1. `eval(` — execução de código arbitrário.
2. `child_process.exec(` com string interpolada/concatenada (nunca `execFile`, que recebe argv
   como array).
3. Senha hardcoded (`password\s*[:=]\s*['"][^'"]{3,}['"]`), ignorando `.env.example` e arquivos
   de teste.
4. SQL montado por concatenação direta de `req.*` (`SELECT/INSERT/UPDATE/DELETE ... + ... req.`)
   — SQL injection por concatenação em vez de bind parameter.

Rodar localmente:

```bash
node scripts/sastScan.js
```

Integrado ao CI em `.github/workflows/test.yml` (step "SAST simples (padrões perigosos
conhecidos em src/)"), logo antes do security scan de dependências.

### Resultado REAL rodado em 08/10/2026

```
Comando: node scripts/sastScan.js
Arquivos varridos: 392
sastScan: 0 ocorrências.
EXIT=0
```

Nenhuma ocorrência de `eval(`, `child_process.exec(` com interpolação, senha hardcoded ou SQL
concatenado com `req.*` em todo `src/` — todo o acesso a banco no repositório usa
`sequelize.query(..., { replacements: ... })` (bind parameters), confirmado pela ausência de
achados desta regra.
