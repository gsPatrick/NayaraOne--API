# Integração da branch de entrega na marco-9

Merge (sem rebase, sem reescrita de histórico) de `origin/marco-6-e-7-homologado-nayara` na `marco-9`, a partir do merge-base `12dce797`. A `marco-9` tinha sido criada antes das correções entregues à Nayara e não as continha; fazer o deploy dela sem este merge regrediria a homologação.

## Commits integrados (20)

- `0296aab4` Corrige o job de reconciliação bancária: where usava updatedAt, mas o model renomeia o atributo para updated_at
- `251f0f65` Evidência da regressão completa do commit 9c822f55 (1837 testes, 0 falhas, 0 pulados); remove o log da rodada antiga e atualiza o guia
- `9c822f55` Regressão reproduzível em banco descartável: script, guia e log do commit 081fc440 (1826 testes, 0 falhas, 0 pulados)
- `c2ef2887` Prazos jurídicos: a troca de responsável lê o prazo com lock (processo, depois prazo), normaliza o UUID para minúsculas e ganha testes de remoção CRITICAL, reset de alerta, UUID maiúsculo e concorrência
- `7f212459` Prazos jurídicos: o PATCH passa a alterar o responsável (antes ignorava o campo), valida vínculo ativo na empresa na criação e na troca e audita antes/depois
- `081fc440` Jurídico: preenchedores raros (khitan U+16FE4 e hieróglifos em branco U+13441/13442) também não valem como prova
- `9133c022` Jurídico: lint do legalText (classe de invisíveis proposital)
- `2b785f74` Jurídico: texto em branco fora de Cc/Cf/Z (Braille em branco U+2800, fillers, Khmer, etc.) não vale como prova
- `a330778c` Jurídico: trava o processo (FOR UPDATE) ao reabrir/criar prazo CRITICAL e ao mudar responsável/escalonamento
- `17dc5164` Prazos jurídicos: ajuste de lint no filtro de caracteres invisíveis (seletores de variação por propriedade Unicode)
- `270b3454` Prazos jurídicos: o status do prazo é normalizado e validado contra PENDING/DONE (400 para valor desconhecido ou que não é texto), de modo que nenhuma variação de DONE pula a exigência de prova
- `6ef2d0f0` Prazos jurídicos: nota de conclusão e textos obrigatórios do prazo (descrição, origem, motivo da mudança) removem espaços e caracteres invisíveis antes de decidir se estão vazios; valor que não é texto é recusado (400) em vez de convertido; data e identificador de arquivo inválidos também são recusados
- `f3f2aa6f` Prazos jurídicos: reabrir um prazo CRÍTICO concluído refaz a exigência de responsável efetivo e destino de escalonamento (422 com código em português), fechando o contorno de tirar responsável/escalonamento do processo antes de reabrir
- `02d395a5` Pós-obra: chamado fechado mantém causa raiz, evidências de antes e depois e atendimento em qualquer atualização (422 ao tentar retirá-los); tela de edição avisa e impede salvar vazio
- `2d3328aa` Documentos da pessoa: trocar o arquivo de um documento preserva o original e cria nova versão pendente, com leitura e confirmação ligadas ao novo arquivo
- `6e476d74` Prazos jurídicos: prazo CRÍTICO exige responsável efetivo e destino de escalonamento desde a criação (e o processo não os perde enquanto houver prazo crítico pendente); nota de conclusão é normalizada e nota só com espaços não vale como evidência
- `4c86c8c4` DIMOB: o congelamento do modelo do arquivo passa a ser serializado por trava de linha (usa sempre o modelo gravado e audita uma única vez) e o gatilho do lote fechado só aceita o preenchimento inicial das duas colunas do modelo com todo o resto idêntico
- `345afbc3` Documentos do caso: o histórico de versões devolve a data de envio real e a situação de validação de cada versão; simulações da NAY e histórico de parâmetros deixam de devolver data vazia
- `372d8638` DIMOB: cada versão do lote guarda o modelo do arquivo (colunas, separador, aviso e layout) e a exportação de lote fechado deixa de mudar quando as configurações mudam
- `498263d9` Correspondente: o provider sandbox e o emissor de NFS-e de teste ficam disponíveis na homologação e só são recusados em produção real

## Conflitos (8 arquivos) e decisões

1. `.gitignore` — as duas linhas se somam: as exclusões de `reports/int-ci`, `reports/offline-run*.json` e `reports/ai-ci` (Marco 9) e a exceção `!docs/evidencias/regressao/*.log` (entrega, para versionar o log da regressão). Além disso entrou a linha `node_modules` (sem barra), ver "Achado: atalho node_modules" abaixo.
2. `src/engines/jobs/bankPaymentReconciliationJob.js` — as duas branches corrigiram o mesmo bug (`updatedAt` no `where` de um model que renomeia o atributo para `updated_at`) de jeitos diferentes. Mantida a versão do Marco 9: `findReconcileCandidates({ groupId, companyId }, transaction)`, com a idade mínima vinda do parâmetro da empresa (`integration.bank.reconcile_min_age_min`, M9-D237), já com `updated_at`. A versão da entrega (constante `MIN_AGE_MS`, assinatura `(transaction)`) foi descartada; o git tinha duplicado a função na auto-fusão e a cópia foi removida.
3. `test/bankPaymentReconciliationJob.candidates.test.js` — mesma decisão: chamada com `{ groupId, companyId }`, assinatura do Marco 9 (o teste dos dois lados cobre o mesmo comportamento: candidato antigo entra, recente e outro status não).
4. `test/timestampRenamedColumns.guard.test.js` — a entrega trouxe o guarda do `where`/`order`; o Marco 9 já tinha esse teste mais o do apelido de leitura (`timestampAliases`: `createdAt`/`updatedAt` lidos pelo atributo real). Mantido o arquivo do Marco 9 (superconjunto).
5. `src/features/correspondent/adapters/resolveFinancingProviderAdapter.js` — o Marco 9 trocou o adapter pelo registro único de integrações (AdapterRegistry, M9-D240); a entrega criou a política `src/utils/sandboxPolicy.js` (sandbox só é recusado em produção real, `DEPLOY_ENVIRONMENT=production` sem `ALLOW_SANDBOX_PROVIDERS=true`; em homologação fica disponível). Mantida a estrutura do Marco 9 e trocada, em `resolveFinancingProviderAdapterByCode`, a condição antiga (`production`/`staging`/`NODE_ENV=production`) por `isSandboxBlocked()`.
6. `src/features/correspondent/fiscal/nfse.service.js` — o Marco 9 moveu a decisão do emissor para `fiscal/nfse/nfse.connection.js` (a função `assertIssuerAllowed` deixou de existir). Descartado o bloco antigo da entrega e levada a política para `nfse.connection.js` (`hardEnvironment = () => isSandboxBlocked()`): em homologação o emissor de NFS-e de teste volta a emitir, só produção real recusa (422 `NFSE_ISSUER_NOT_CONFIGURED`).
7. `src/modules/legal/cases/legal-case.service.js` — imports: mantidos os dois (`publishLegalCaseUpdated` do Marco 9 e `assertCaseKeepsCriticalAccountability` da entrega).
8. `src/modules/legal/cases/deadline.service.js` — imports somados (`publishDeadlineChange` do calendário do Marco 9 e os módulos de texto, responsável e prestação de contas da entrega). Em `updateLegalDeadline`: a validação da entrega (status normalizado e validado, UUID, nota normalizada, troca de responsável, FOR UPDATE na ordem processo -> prazo, reabertura CRITICAL) foi mantida inteira, e do Marco 9 ficaram `const beforeStatus = deadline.status` (antes da alteração) e a publicação `publishDeadlineChange(deadline, beforeStatus, transaction)` ao final, para o calendário continuar fechando/reabrindo o item pela origem.

## Ajustes feitos por causa da integração (sem conflito textual)

- `docs/governance/data-classification.json`: o guarda `check:classification` do Marco 9 falhou porque as colunas novas da entrega (`correspondent.dimob_batches.file_model_hash` e `file_model_json`, migration 647) não estavam classificadas. Rodado `sync:classification`: só essas duas colunas entraram (4.558 colunas de negócio, cobertura 100%).
- `test/marco8/dimobCongelamentoConcorrente.test.js` (teste da entrega): gravava lotes commitados com ano fixo (2051/2052) e só passava num banco novo; numa segunda passada no mesmo banco quebrava na unicidade `dimob_batches_unique_version`. O ano agora sai de uma faixa sorteada a cada execução. Nenhuma asserção foi alterada.

## Achado: atalho `node_modules` versionado por engano

O commit `081fc440` da entrega incluiu na árvore um symlink `node_modules` apontando para si mesmo (o `.gitignore` tinha `node_modules/` com barra, que não casa com symlink). O merge o materializou e apagou o `node_modules` real do ambiente local de desenvolvimento (reinstalado com `npm ci`, iguais ao `package-lock.json`). No merge o atalho foi removido do índice (`git rm --cached`) e o `.gitignore` passou a ignorar `node_modules` sem barra. O deploy da `marco-9` não contém o atalho. O histórico da entrega não foi alterado.

## Migrations

A entrega só adiciona `20260101000647-dimob-modelo-do-arquivo-por-versao.js` e `20260101000648-dimob-gatilho-congelamento-estrito.js`, já aplicadas na homologação. Nenhuma migration foi renomeada ou renumerada. A sequência na árvore fica: 0 a 648 (com 647 e 648), 650 a 659 ..., até 9964, com a 649 sem arquivo (não existe em nenhuma das duas branches; a numeração já tinha outras lacunas históricas, anteriores a este merge). Conferência contra o dump da homologação (`backups/homologacao_fase2_2026-11-02.dump`) em `Maturacao/demandas/_rastreabilidade/auditoria-cega/marco-9-integracao-da-entrega.md`.
