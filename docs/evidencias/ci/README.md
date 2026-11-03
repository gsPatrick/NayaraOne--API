# Evidências de CI — logs individuais da suíte de testes

Resposta ao item **E01** da conferência da Nayara de 18/10/2026: "Enviar o test-results.log original desse run e esclarecer o nome. Conferir contagem, falhas/skips, nomes dos testes e incluir os três R3."

A API de download de artifacts do GitHub exige login mesmo em repositório público (por isso a IA da auditoria recebeu HTTP 403). Os logs abaixo são **cópias SANEADAS do `test-results.log` de dentro do artifact original** de cada run (ver "Logs saneados" abaixo), versionadas aqui para ficarem acessíveis sem login pelo link raw do GitHub.

## Run final dos Marcos 4/5 — 39301913793 (commit `3f7e550`)

- Run: https://github.com/gsPatrick/NayaraOne--API/actions/runs/39301913793 — evento `push` na branch `marco-6-e-7-homologado-nayara`, `conclusion=success`, criado em 2026-10-19T18:22:11Z.
- Commit avaliado: `3f7e5500e00c609cf5c4da2f8a5b5573cfbf48d8`. Como o evento é `push`, não existe commit de merge temporário: o artifact se chama exatamente `test-results-3f7e5500e00c609cf5c4da2f8a5b5573cfbf48d8` (id 12210643253, digest do zip `sha256:2c376ef482f2a08e7cff0b9321c15aba043eeb42aaa91d4caf24ad3ccd8ff76a`, expira em 17/01/2027).
- Resultado: `ℹ tests 1429 / pass 1429 / fail 0 / cancelled 0 / skipped 0 / todo 0`. Os sete testes R3 e os 12 testes de dois tenants (Compras, Financeiro e Jurídico) estão no log e verdes.
- Front correspondente: run https://github.com/gsPatrick/NayaraOne--FRONT/actions/runs/39301378437 (commit `728e99fa80aa693762141335b00cf0b7651cbb6d`, `push`, `success`).
- `39301913793-3f7e550-test-results.log` é a versão saneada do `test-results.log` do artifact (baixado com `gh run download 39301913793 -R gsPatrick/NayaraOne--API`); o `.sha256` ao lado é o do arquivo saneado e o do original está em `SANEAMENTO.json`.

## Reprodução completa (comando idêntico ao do CI)

O script `scripts/reproduzir-conferencia.sh` executa o mesmo que o job `test` de `.github/workflows/test.yml`. **O script foi ajustado ao workflow; o comando de teste do CI não foi alterado.**

```bash
# 1. obter exatamente o commit avaliado
git clone https://github.com/gsPatrick/NayaraOne--API.git && cd NayaraOne--API
git checkout <HASH-DO-COMMIT>          # o hash está no cabeçalho do log e na página de entrega

# 2. pré-requisitos
#    - Node 20 (a versão do CI; com outra major o script avisa no cabeçalho do log, ou aborta com REPRO_REQUIRE_NODE20=1)
#    - Docker OU PostgreSQL 16 com initdb (Homebrew: postgresql@16; Debian/Ubuntu: postgresql-16)
#    - git; para baixar artifacts do CI: gh autenticado
node -v && npm ci

# 3. executar (do zero: lint, syntax-check, scanner de hard-code, SAST, security scan, migrations,
#    seeds, role sem bypass de RLS, suíte inteira)
REPRO_CAPTURA=1 bash scripts/reproduzir-conferencia.sh ./test-results.log
#    gera ./test-results.log (original, local), ./test-results.saneado.log e ./test-results.captura.json

# comando de teste do CI (dentro do script, sem --test-concurrency=1; REPRO_SERIAL=1 roda em série):
node --test --test-reporter=spec --test-reporter-destination=stdout test/*.test.js

# 4. logs e artifacts do CI de um run (precisa de login no GitHub)
gh run download <RUN_ID> -R gsPatrick/NayaraOne--API        # artifact test-results-<commit>

# 5. reexecutar no próprio GitHub, sem deploy: Actions > CI > Run workflow (evento workflow_dispatch;
#    o deploy de produção só roda se a entrada deploy_production for marcada)
```

Mesmos ambiente e seeds do workflow: Postgres 16, `NODE_ENV=development` para migrations/seeds e `NODE_ENV=test` na suíte, os segredos `*-not-for-production` do workflow, `seed-dev.js`, `seedBillingRules.js`, `seedRealEstateRules.js`, `seed-ci-two-tenants.js` e a role `nayara_ci_app` (NOSUPERUSER NOBYPASSRLS) com GRANT por schema enumerado do catálogo. O workflow também falha o build se o log tiver JWT ou string de conexão.

A página de entrega é regenerada com `node scripts/gerar-entrega-marco45.js --api-run <RUN_ID> --front-run <RUN_ID_FRONT>` (baixa o artifact, sanea, calcula hashes e lê o log do commit final) e verificada com `node scripts/checar-entrega-marco45.js <pagina.html>`.

## Reprodução local — `scripts/reproduzir-conferencia.sh`

Faz em qualquer máquina o mesmo que o job `test` do workflow, sem tocar em banco compartilhado:

1. sobe um PostgreSQL 16 **descartável** — `docker run postgres:16` quando há Docker; sem Docker, um cluster local criado com `initdb` num diretório temporário (porta própria, padrão 55432);
2. roda as migrations do zero e os seeds `seed-dev`, `seedBillingRules`, `seedRealEstateRules` e `seed-ci-two-tenants` (dois tenants fictícios, perfis maker/checker/leitura) como superusuário do cluster;
3. cria a role `nayara_ci_app` NOSUPERUSER NOBYPASSRLS com GRANT por schema (schemas enumerados do catálogo, como no CI);
4. roda a suíte inteira com `NODE_ENV=test`, reporter `spec`, gravando `test-results.log` com cabeçalho (commit avaliado, modo do Postgres, usuário do banco, versão do Node);
5. remove o banco no final (container ou cluster e diretório).

Neutraliza as chaves do `.env` local que o script não define (o `dotenv` não sobrescreve variável existente), então nada do ambiente de desenvolvimento vaza para a reprodução.

```bash
bash scripts/reproduzir-conferencia.sh                      # suíte inteira -> ./test-results.log
bash scripts/reproduzir-conferencia.sh /tmp/r.log 'test/nayaraConferencia1810*.test.js'   # recorte
REPRO_FORCE_LOCAL=1 REPRO_PG_PORT=55440 bash scripts/reproduzir-conferencia.sh           # sem docker, outra porta
```

Execução de 19/10/2026 nesta máquina (sem Docker instalado, portanto cluster local PostgreSQL 16.14), commit `3f7e550`, Node v24.18.0, arquivos em série (`--test-concurrency=1`): **1429 testes, 1429 aprovados, 0 falhas, 0 pulados**, 205,8 s. Log em [`local-reproducao-3f7e550-test-results.log`](./local-reproducao-3f7e550-test-results.log). O conjunto de nomes de testes aprovados é idêntico ao do run 39301913793 (`diff` das listas ordenadas vazio). O cabeçalho registra "arquivos rastreados modificados: 1" — era `docs/evidencias/MAPA_SEGURANCA.md` (documentação, sem efeito na suíte).

### Reprodução no código final (badc180)

Depois do cruzamento integral dos cadernos dos Marcos 4/5 (commits `390b60d`, `e834c68`, `ace9b74`, `8eef9a8`), rodei de novo a suíte inteira com o mesmo script: **1463 testes, 1463 aprovados, 0 falhas, 0 pulados** (`local-reproducao-badc180-test-results.log`). Os 34 testes a mais em relação ao CI 39301913793 são os desta entrega (e um do Marco 7); entram no CI no próximo push. Drill de restore jurídico rodado no mesmo código: 133/133, log em `docs/evidencias/marco4-5/`.

## Por que o nome do artifact não bate com o commit

Os dois runs abaixo foram disparados pelo evento `pull_request` (PR #1, branch `marco-6-e-7-homologado-nayara` → `main`). Nesse evento, a variável `github.sha` do GitHub Actions não é o commit da branch: é o **commit de merge temporário** que o GitHub cria em `refs/pull/1/merge` para testar como a branch ficaria mesclada. O workflow nomeava o artifact com `github.sha`, daí a diferença:

| Run | Commit da branch (avaliado) | Commit de merge temporário | Nome do artifact |
|---|---|---|---|
| [39127433976](https://github.com/gsPatrick/NayaraOne--API/actions/runs/39127433976) | `8f7c97c3f864c774dc6db2f9dcd9782316d8d8c1` | `14e9580c36e7c244b437a5959dacf78a3073c7e1` — "Merge 8f7c97c… into 19f5918…" | `test-results-14e9580c…` |
| [39137022521](https://github.com/gsPatrick/NayaraOne--API/actions/runs/39137022521) | `0ab0e7b78568b5c5c72d1830af2701027f1a3510` | `f644bd754b4908f48e2cdbfaab1d885119761545` — "Merge 0ab0e7b… into 19f5918…" | `test-results-f644bd75…` |

Pode ser conferido com `gh run view <run> --json event,headSha` e `gh api repos/gsPatrick/NayaraOne--API/commits/<sha-de-merge>` (a mensagem do commit de merge cita o commit da branch como segundo pai). Os metadados do artifact (`workflow_run.head_sha`) já apontavam para o commit da branch.

**Corrigido no workflow** (`.github/workflows/test.yml`): a partir do próximo run, o artifact se chama `test-results-<commit da branch>` (em `pull_request` usa `github.event.pull_request.head.sha`; em `push`, `github.sha`), o log começa com um cabeçalho com evento, commit avaliado, commit de merge (se houver), link do run e usuário do banco, e a contagem e a lista de falhas/pulados também ficam no **resumo público do job**, visível na página do run sem login.

## Arquivos (logs SANEADOS)

Todos os logs versionados aqui são **saneados**: o log original continha o cabeçalho `Authorization` completo (um JWT de usuário fictício) em cerca de 350 linhas de log JSON de requisição da API. Origem: o logger de requisições imprimia o header. A API foi corrigida (`src/utils/logger.js`, teste `test/logRedaction.test.js`) e os logs foram saneados por `scripts/sanear-log-teste.js`: **removidas as linhas que começam com `{"level":`** (log JSON de requisição, que não é resultado de teste) e qualquer outra linha com padrão de segredo (nenhuma outra foi necessária). **Nenhuma linha de resultado de teste (`✔ ✖ ﹣ ▶ ℹ`) foi alterada**: o conjunto dessas linhas tem o mesmo SHA-256 no original e no saneado. Por isso o SHA-256 do arquivo versionado **difere** do SHA-256 do artifact original; as duas colunas estão abaixo e o SHA-256 do original também está no cabeçalho de cada log. Os originais ficam fora do repositório (os tokens eram de usuários fictícios, assinados com um segredo exclusivo do CI, de 15 minutos de validade, mas continuam no histórico do git dos commits antigos).

Detalhe por arquivo em [`SANEAMENTO.json`](./SANEAMENTO.json).

| Arquivo | SHA-256 do arquivo saneado (publicado) | SHA-256 do original | Linhas JSON removidas | Bytes |
|---|---|---|---|---|
| [`39127433976-8f7c97c-test-results.log`](./39127433976-8f7c97c-test-results.log) — run 39127433976 (pull_request) | `d71431bcd8011cce71930286977abe520889c2e75d785226f99ea32ed67dcd07` | `4959a27f9964b1986fc5c2cafb54dce12334eaebbcd70ddbe967a63ffb0c12a2` | 137 | 320920 → 162174 |
| [`39137022521-0ab0e7b-test-results.log`](./39137022521-0ab0e7b-test-results.log) — run 39137022521 (pull_request) | `27a544605de424e8268ff814fe43bd8175c0fe142b6e970b663cf9cab47d829a` | `4a251a9edb6d482c1a15354d3077cb6e7016596bed1066bb0b814d91b2a39d57` | 147 | 336298 → 163996 |
| [`39301913793-3f7e550-test-results.log`](./39301913793-3f7e550-test-results.log) — **run final anterior dos Marcos 4/5** (push, sem commit de merge) | `8512dd7e4db586d51fba0a159c57bdf7e6239681fda42063d37a946225f6bdf2` | `46dd37c2e5b28156b15448c1b9bf272aeac9a9d3bebad5f9abdd073953d5638c` | 510 | 753187 → 197936 |
| [`local-reproducao-3f7e550-test-results.log`](./local-reproducao-3f7e550-test-results.log) — reprodução local (`scripts/reproduzir-conferencia.sh`) no commit 3f7e550 | `a7ce2f21400cbcc16eaf4984427fc6ec1b142d6f864616ecaf16293dd1551828` | `31f5c74146dbd93646b5e05059a2a7924b91b84c3db41bf2c808407d1b18b410` | 510 | 752197 → 197112 |
| [`local-reproducao-badc180-test-results.log`](./local-reproducao-badc180-test-results.log) — reprodução local no commit badc180 | `dbe0dc0014a831d5f2c6b863a0cd09d1cd6a521e171066f70728450d007d45c2` | `0a2a184ea135583a98d46f2528385aed5c644221f570b4f49253b25a8cd135f2` | 534 | 782558 → 206374 |
| [`local-reproducao-470ecc1-test-results.log`](./local-reproducao-470ecc1-test-results.log) — **reprodução local completa no código final** (Node v20.20.2, PostgreSQL 16.14 descartável, em série, `REPRO_CAPTURA=1`) | `cc257e9873c1f7754178fc290ab351e5b035719a8a6257b882399001cd2e8b1c` | `9815615c59f0e1a97703b8f58a2b424dbb1f0852bd4bf09cfdd160e457e6864c` | 552 | 622689 → 210326 |

Contagens dos runs (iguais no original e no saneado): 39127433976 → 1137/1137; 39137022521 → 1152/1152; 39301913793 → 1429/1429; reprodução local 3f7e550 → 1429/1429; reprodução local badc180 → 1463/1463; reprodução local 470ecc1 → 1498/1498 (pass/tests, 0 falhas, 0 pulados). A captura HTTP/SQL do mesmo banco está em `docs/entrega-marco45/captura-descartavel.json`.

Digest oficial do GitHub para o **zip** de cada artifact (não do log): run 39127433976 → `sha256:5276f6b18e8ced915175c2625b9a2902709ca8fcda413217684a8d3de89976c4` (artifact id 12137255014); run 39137022521 → `sha256:2b7a6b312d78d87417dbd80f6b1b81dfdd257b9aad0c449ac69978ed52e79cb0` (artifact id 12140006965). Ambos expiram em 16/01/2027 no GitHub; as cópias aqui não expiram.

### Os três R3 (achados da rodada anterior da auditoria), presentes e verdes nos dois logs

Arquivo `test/nayaraExternalAuditR3.test.js`:

- `R3-1: prazo OVERDUE com responsável próprio, processo SEM responsável — job cria Notification pro responsável do PRAZO`
- `R3-1 (controle): prazo sem responsável próprio continua notificando o responsável do PROCESSO`
- `R3-2: lançamento editado DEPOIS da aprovação invalida a aprovação — baixa integral e parcial recusadas`
- `R3-2 (controle): aprovação sem edição posterior continua liberando a baixa normalmente`
- `R3-2 (reaprovação): depois de editar, uma NOVA aprovação sobre a versão atual volta a liberar a baixa`
- `R3-3: garantia ACTIVE com startsAt no FUTURO bloqueia a entrega de chaves`
- `R3-3 (controle): garantia ACTIVE com vigência corrente (startsAt ontem, endsAt futuro) libera normalmente`

## Como conferir

```bash
# baixar sem login
curl -LO https://raw.githubusercontent.com/gsPatrick/NayaraOne--API/marco-6-e-7-homologado-nayara/docs/evidencias/ci/39127433976-8f7c97c-test-results.log
curl -LO https://raw.githubusercontent.com/gsPatrick/NayaraOne--API/marco-6-e-7-homologado-nayara/docs/evidencias/ci/39127433976-8f7c97c-test-results.log.sha256

shasum -a 256 -c 39127433976-8f7c97c-test-results.log.sha256   # integridade
grep -E '^ℹ (tests|pass|fail|cancelled|skipped|todo)' 39127433976-8f7c97c-test-results.log   # contagem
grep -cE '^[[:space:]]*✔' 39127433976-8f7c97c-test-results.log  # testes aprovados (inclui sub-testes) = 1137
grep -E '^[[:space:]]*(✖|﹣)' 39127433976-8f7c97c-test-results.log  # falhas/pulados (vazio = nenhum)
grep 'R3-' 39127433976-8f7c97c-test-results.log                  # os três R3
```

Quem tiver login no GitHub pode baixar o artifact original (`gh run download 39127433976 --repo gsPatrick/NayaraOne--API`) e comparar: o `test-results.log` de dentro do zip tem o mesmo SHA-256 da tabela acima.

## Observações

- O reporter `spec` imprime sub-testes indentados (`  ✔ …`). Por isso contar só linhas que começam com `✔` dá 1113 no run 39127433976; contando também os indentados dá 1137, igual à linha `ℹ tests` emitida pelo próprio `node --test`. Nenhuma linha `✖` ou `﹣` (pulado) em nenhum dos dois logs.
- Os logs versionados são saneados (ver acima): sem token e sem log JSON de requisição.
- Os testes rodam com o usuário `nayara_ci_app` (NOSUPERUSER, NOBYPASSRLS), criado pelo próprio workflow. Isso prova o comportamento com RLS ativo no banco do CI; não prova sozinho a configuração do usuário do banco publicado.
- Os testes de dois tenants (seção abaixo) são posteriores aos dois logs acima e não aparecem neles. Compras aparece a partir do run 39147600917 (commit `46b0ecb`); Financeiro e Jurídico, a partir do primeiro run que incluir `test/ciTwoTenantsFinanceLegal.test.js`.

## Ambiente isolado com dois tenants e perfis maker/checker/leitura (roteiro item 4)

O workflow cria, no Postgres descartável do job e depois do seed base, **dois tenants fictícios** (`CI — Empresa Fictícia A` e `B`), cada um com três usuários fictícios (`scripts/seed-ci-two-tenants.js`, senha só no workflow em `CI_TENANT_USERS_PASSWORD`). As permissões vêm do catálogo real (`core.permissions`); se faltar alguma, o seed falha em vez de inventar.

| Perfil | Permissões | Papel no teste |
|---|---|---|
| maker | `procurement:create`, `procurement:read`, `finance:create`, `finance:read`, `legal:create`, `legal:read` | cria e solicita |
| checker | `procurement:approve`, `procurement:create`, `procurement:read`, `finance:approve`, `finance:create`, `finance:read`, `legal:approve`, `legal:create`, `legal:read` | aprova; também pode criar, para provar que "quem cria não aprova" vem da regra de negócio e não da falta de permissão |
| leitura | `procurement:read`, `finance:read`, `legal:read` | só lê |

Os testes fazem login real (senha → JWT com as permissões lidas do banco) e usam as rotas HTTP reais, com o usuário `nayara_ci_app` sem bypass de RLS. Fora do CI são pulados com motivo explícito.

**Compras (Marco 7) — `test/ciTwoTenantsProfiles.test.js`**
- os tokens carregam exatamente as permissões da tabela, e o perfil leitura só tem `:read`;
- maker cria pedido de compra e recebe 403 ao aprovar; checker aprova o pedido do maker;
- checker recebe `PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN` ao aprovar o próprio pedido;
- leitura recebe 403 ao criar e consegue listar;
- tenant B não vê o pedido de A na lista, recebe 404 ao ler e ao decidir, e o pedido de A continua `REQUESTED`.

**Financeiro (Marco 4) — `test/ciTwoTenantsFinanceLegal.test.js`**
- maker cria centro de custo e lançamento a pagar, abre a solicitação de aprovação e recebe 403 ao decidir; checker aprova (`APPROVED`);
- checker recebe `FINANCE_APPROVAL_SELF_APPROVAL_FORBIDDEN` ao decidir a solicitação que ele mesmo abriu;
- leitura recebe 403 ao criar lançamento e ao pedir aprovação, e consegue listar e ler o lançamento;
- tenant B recebe 404 ao ler o lançamento de A e ao decidir a aprovação de A, não vê essa aprovação na lista, e ela continua `PENDING` para A.

**Jurídico (Marco 5) — `test/ciTwoTenantsFinanceLegal.test.js`**
- maker cria contrato (`DRAFT`); leitura recebe 403 ao criar e consegue ler;
- tenant B não vê o contrato de A na lista, recebe 404 ao ler e ao tentar mudar o status (`/transition`), e o contrato de A continua `DRAFT`;
- condição de cláusula (F01): maker cria a cláusula condicional (`PENDING_APPROVAL`) e recebe 403 ao aprovar; checker do tenant B recebe 404; checker de A aprova (`APPROVED`); checker recebe `LEGAL_CLAUSE_CONDITION_SELF_APPROVAL_BLOCKED` ao aprovar a que ele mesmo criou.

Validação local antes do push (18/10/2026): Postgres 16 descartável, migrations do zero, `seed-dev` + regras + `seed-ci-two-tenants`, testes como `nayara_ci_app` (NOSUPERUSER, NOBYPASSRLS): 12 de 12 aprovados nos dois arquivos.
