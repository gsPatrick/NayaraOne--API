# Evidências de CI — logs individuais da suíte de testes

Resposta ao item **E01** da conferência da Nayara de 18/10/2026: "Enviar o test-results.log original desse run e esclarecer o nome. Conferir contagem, falhas/skips, nomes dos testes e incluir os três R3."

A API de download de artifacts do GitHub exige login mesmo em repositório público (por isso a IA da auditoria recebeu HTTP 403). Os logs abaixo são **cópias byte a byte do `test-results.log` de dentro do artifact original** de cada run, versionadas aqui para ficarem acessíveis sem login pelo link raw do GitHub.

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
- Ambiente isolado (roteiro item 4): a partir deste commit o CI também cria dois tenants fictícios, cada um com perfis maker/checker/leitura (`scripts/seed-ci-two-tenants.js`), e `test/ciTwoTenantsProfiles.test.js` prova pelo caminho HTTP real que maker não aprova, checker não aprova o próprio pedido, checker aprova o do maker, leitura recebe 403 ao criar e o tenant B não enxerga nem decide o pedido do tenant A. Esses testes ainda não aparecem nos dois logs acima (são posteriores a eles); aparecerão no próximo run.
