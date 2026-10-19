# Evidências de CI — logs individuais da suíte de testes

Resposta ao item **E01** da conferência da Nayara de 18/10/2026: "Enviar o test-results.log original desse run e esclarecer o nome. Conferir contagem, falhas/skips, nomes dos testes e incluir os três R3."

A API de download de artifacts do GitHub exige login mesmo em repositório público (por isso a IA da auditoria recebeu HTTP 403). Os logs abaixo são **cópias byte a byte do `test-results.log` de dentro do artifact original** de cada run, versionadas aqui para ficarem acessíveis sem login pelo link raw do GitHub.

## Run final dos Marcos 4/5 — 39301913793 (commit `3f7e550`)

- Run: https://github.com/gsPatrick/NayaraOne--API/actions/runs/39301913793 — evento `push` na branch `marco-6-e-7-homologado-nayara`, `conclusion=success`, criado em 2026-10-19T18:22:11Z.
- Commit avaliado: `3f7e5500e00c609cf5c4da2f8a5b5573cfbf48d8`. Como o evento é `push`, não existe commit de merge temporário: o artifact se chama exatamente `test-results-3f7e5500e00c609cf5c4da2f8a5b5573cfbf48d8` (id 12210643253, digest do zip `sha256:2c376ef482f2a08e7cff0b9321c15aba043eeb42aaa91d4caf24ad3ccd8ff76a`, expira em 17/01/2027).
- Resultado: `ℹ tests 1429 / pass 1429 / fail 0 / cancelled 0 / skipped 0 / todo 0`. Os sete testes R3 e os 12 testes de dois tenants (Compras, Financeiro e Jurídico) estão no log e verdes.
- Front correspondente: run https://github.com/gsPatrick/NayaraOne--FRONT/actions/runs/39301378437 (commit `728e99fa80aa693762141335b00cf0b7651cbb6d`, `push`, `success`).
- `39301913793-3f7e550-test-results.log` é cópia byte a byte do `test-results.log` de dentro do artifact (baixado com `gh run download 39301913793 -R gsPatrick/NayaraOne--API`); o `.sha256` ao lado confere.

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

## Arquivos

| Arquivo | SHA-256 do log | Testes | Pass | Fail | Cancelled | Skipped | Todo |
|---|---|---|---|---|---|---|---|
| [`39127433976-8f7c97c-test-results.log`](./39127433976-8f7c97c-test-results.log) | `4959a27f9964b1986fc5c2cafb54dce12334eaebbcd70ddbe967a63ffb0c12a2` | 1137 | 1137 | 0 | 0 | 0 | 0 |
| [`39137022521-0ab0e7b-test-results.log`](./39137022521-0ab0e7b-test-results.log) | `4a251a9edb6d482c1a15354d3077cb6e7016596bed1066bb0b814d91b2a39d57` | 1152 | 1152 | 0 | 0 | 0 | 0 |
| [`39301913793-3f7e550-test-results.log`](./39301913793-3f7e550-test-results.log) — **run final dos Marcos 4/5** (evento `push`, sem commit de merge) | `46dd37c2e5b28156b15448c1b9bf272aeac9a9d3bebad5f9abdd073953d5638c` | 1429 | 1429 | 0 | 0 | 0 | 0 |
| [`local-reproducao-3f7e550-test-results.log`](./local-reproducao-3f7e550-test-results.log) — reprodução local (`scripts/reproduzir-conferencia.sh`) | `31f5c74146dbd93646b5e05059a2a7924b91b84c3db41bf2c808407d1b18b410` | 1429 | 1429 | 0 | 0 | 0 | 0 |
| [`local-reproducao-badc180-test-results.log`](./local-reproducao-badc180-test-results.log) — reprodução local no código final da entrega dos Marcos 4/5 (inclui os testes novos ainda sem CI) | `0a2a184ea135583a98d46f2528385aed5c644221f570b4f49253b25a8cd135f2` | 1463 | 1463 | 0 | 0 | 0 | 0 |

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
- O log contém linhas de log HTTP dos testes de rota, incluindo cabeçalhos `Authorization: Bearer …`. São tokens de usuários **fictícios** de teste, assinados com o segredo exclusivo do CI (`ci-access-secret-not-for-production`, público no próprio workflow), com validade de 15 minutos e válidos só contra o banco descartável do job, destruído ao fim do run. Foram mantidos para que o arquivo continue idêntico ao do artifact.
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
