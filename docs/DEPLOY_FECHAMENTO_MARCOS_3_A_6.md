# Deploy do fechamento dos Marcos 3 a 6 — migrations depois do Marco 9

Este roteiro vale para a versão da integração dos Marcos 3 a 6 sobre o Marco 9 entregue (`9863bee2`). São 56 migrations novas sobre a
homologação de hoje (que já tem o plano do Marco 9 inteiro, `docs/DEPLOY_MARCO_9.md`). Elas foram ensaiadas de duas formas em 13/11/2026:

1. Banco descartável com as migrations do Marco 9 e, por cima, as da integração (mesma ordem da homologação): as 56 aplicam e nada fica pendente.
2. **Com os dados da homologação**: o backup de 13/11/2026 08:14 (`backups/homolog-antes-marco9-20261113-0814.dump`, SHA-256 `a3b253f2…`) restaurado num
   PostgreSQL local, as 7 migrations do Marco 9 (como no deploy do Marco 9) e então as 56 da integração, com o usuário dono das tabelas com os
   mesmos atributos da homologação (superusuário e BYPASSRLS, conferido por consulta somente leitura). Todas aplicam, em cerca de 4 s.

A API anterior (Marco 9 sem os Marcos 3 a 6) NÃO funciona depois destas migrations (nomes de tabela do livro do Marco 5, colunas novas). Elas sobem
junto com a API e o Front da integração, com a API parada, como no `docs/DEPLOY_FECHAMENTO_MARCO_5.md`.

## Ordem

1. Backup novo imediatamente antes (`pg_dump -Fc`, com SHA-256), guardado fora do servidor.
2. Parar a API.
3. Aplicar as migrations: `node scripts/migrate.js up` no console do serviço da API (o mesmo executor do boot com `RUN_MIGRATIONS_ON_BOOT`).
   Conferir `node scripts/migrate.js status`: nenhuma `down`.
4. Deploy da API e do Front da integração; conferir `/api/version` (commit da integração) e `/api/health`.
5. Reteste do ponto 5 do Marco 9 na homologação (`scripts/homo/retestePonto5Marco9.js`) e fumaça dos Marcos 3 a 6.

## O que as migrations mudam nos dados que já existem (resultado do ensaio com o backup)

- `20260101010940` (vínculo da pessoa com a empresa): toda pessoa ganha o vínculo OWNER com a empresa que a cadastrou (no ensaio: 1.512 pessoas, 1.512 vínculos, nenhuma sem vínculo).
  As conferências da 10941 e da 10944 acharam 0 linha sem vínculo nas 29 referências a pessoa.
- `20260101009975` (funil do livro): as etapas antigas das oportunidades passam aos nomes do livro (NOVO -> NEW, NEGOTIATION -> PROPOSAL, CLOSED_LOST -> LOST).
  `20261111031002`: oportunidade aberta sem responsável recebe responsável (no ensaio: nenhuma ficou sem).
- `20260101010520` (ledger do Marco 4, M4LR): corrige o ledger antigo, cada correção numa linha de `finance.ledger_m4lr_migration_log` e no `audit.audit_log`, nada
  apagado e o `down` desfaz pelo log. No ensaio: 634 chaves `legado:<id>`, 109 tipos de movimento, 37 estornos de previsto nunca realizado tirados do ledger,
  2 estornos do valor cheio de pai com baixas parciais substituídos por 4 estornos corretos das baixas (4 lançamentos novos, `reversal:<id>:correcao-m4lr`), 5 autores.
- `20260101006603` (evidência da medição, Marco 6): 33 medições PAYABLE antigas sem a conta a pagar ligada; 4 recebem o vínculo com a conta que o fluxo antigo
  criou (`measurement.payable:<id>`) e **29 ficam sem conta**. Por isso a CHECK `stage_measurements_payable_has_entry` fica criada SEM validar (vale para toda
  medição nova ou alterada). Decisão do Patrick, caso a caso (gerar a conta a pagar ou reverter a medição); depois:
  `ALTER TABLE construction.stage_measurements VALIDATE CONSTRAINT stage_measurements_payable_has_entry;`. Consulta somente leitura para listar:

  ```sql
  SELECT id, company_id, total_amount, created_at FROM construction.stage_measurements
   WHERE status = 'PAYABLE' AND payable_financial_entry_id IS NULL ORDER BY created_at;
  ```
- Regras do livro do Marco 5 criadas sem validar o passado (valem para linha nova ou alterada): `guarantees_type_livro_chk`, `inspections_type_livro_chk`,
  `inspection_items_condition_livro_chk`, `lease_obligations_periodicity_chk`, `lease_obligations_due_day_chk`, `legal_deadlines_status_chk`.

## Usuário das migrations

Na homologação o dono das tabelas é superusuário com BYPASSRLS (conferido em 13/11/2026), então as cargas de dados das migrations enxergam todas as empresas.
Em outro ambiente em que o dono NÃO tenha BYPASSRLS, as cargas que leem tabelas com RLS forçado não enxergam linha nenhuma; as migrations 9966, 9971, 10940 e
6603 já tiram o FORCE só durante a carga, as demais precisam do mesmo cuidado antes de rodar nesse ambiente.

## Plano de reversão

Restaurar o backup do passo 1 e reimplantar a API e o Front do Marco 9 (`9863bee2` / Front `a26d3da`). As migrations têm `down`, mas várias renomeiam tabelas e
corrigem dados; o caminho seguro de volta é o backup.

## Migrations (56, na ordem em que aplicam sobre a homologação)

**Marco 6 (Obras: verificação)** (8)

- `20260101006600-m6v-tipo-de-obra-e-checklist-por-etapa`
- `20260101006601-m6v-responsavel-da-etapa`
- `20260101006602-m6v-baseline-imutavel-e-revisoes`
- `20260101006603-m6v-evidencia-da-medicao`
- `20260101006604-finance-source-event-id-e-obra-na-baixa-parcial`
- `20260101006605-m6v-alcada-permissao-propria-e-quem-propoe`
- `20260101006606-finance-indices-da-obra-no-ledger`
- `20260101006607-m6v-indices-da-saude-da-obra`

**Marco 3 (Pessoas, Imóveis e CRM)** (19)

- `20260101009971-m3-livro-ocorrencias-e-interacoes`
- `20260101009972-create-crm-radar-matches`
- `20260101009973-seed-permissao-troca-de-responsavel-em-massa`
- `20260101009974-m3-livro-entidades-com-o-nome-do-livro`
- `20260101009975-m3-funil-converte-etapas-antigas`
- `20260101010310-m3im-imovel-arquivo-condicoes-e-substituicao`
- `20260101010311-m3im-historico-de-preco-append-only`
- `20260101010312-m3im-regra-campos-obrigatorios-publicacao`
- `20260101010313-m3im-carrinho-rastreio`
- `20260101010940-pessoas-vinculo-por-empresa`
- `20260101010941-pessoas-filhos-so-com-pessoa-vinculada`
- `20260101010942-pessoas-permissao-vincular`
- `20260101010943-pessoas-filhos-unicidade-por-empresa`
- `20260101010944-pessoas-chave-composta-nos-outros-modulos`
- `20260101010960-pessoas-deduplicacao-no-grupo`
- `20261111030001-crm-interacoes-imutaveis`
- `20261111030200-crm-oportunidade-retrato-financiamento`
- `20261111031001-m3-funil-won-lost-e-motivos-configuraveis`
- `20261111031002-m3-oportunidade-sem-responsavel-recebe-responsavel`

**Marco 5 (Contratos, Locação e Jurídico)** (20)

- `20260101009981-legal-aprovacao-por-versao-e-arquivo-da-versao`
- `20260101009982-legal-template-versions`
- `20260101009983-legal-clause-library-e-clause-versions`
- `20260101009986-legal-addenda`
- `20260101009987-legal-partes-representadas-e-etapa-das-exigencias`
- `20260101009990-m5-locacao-garantias-dados-por-tipo`
- `20260101009991-m5-locacao-vistorias-codigos-do-livro-e-midias`
- `20260101009992-m5-locacao-lease-obligations`
- `20260101009993-m5-locacao-chaves-termo-assinado-e-permissao`
- `20260101009996-legal-case-parties-nome-do-livro`
- `20260101009997-legal-prazo-origem-tarefa-cancelamento`
- `20260101009998-legal-notificacao-versoes-e-recebivel-do-processo`
- `20260101009999-legal-permissao-exportar-dossie`
- `20260101015101-m5-permissao-aprovar-versao-do-contrato`
- `20260101015103-legal-modelo-termo-imovel-usado`
- `20260101015104-legal-clausula-homologada-e-minuta-nay`
- `20260101015600-m5vp-garantia-substituida-e-laudo-assinado-imutaveis`
- `20260101015601-m5vp-recebivel-do-processo-bases-configuraveis`
- `20260101015602-m5vp-ciclos-das-obrigacoes-da-locacao`
- `20260101015603-m5vp-nay-juridica-compara-vistorias`

**Marco 4 (Financeiro)** (9)

- `20260101009984-reconciliations-match-method`
- `20260101009985-finance-unicidade-por-conta-e-empresa`
- `20260101009988-dec007-fin005-para-parametros`
- `20260101009989-dec007-niveis-de-risco-dos-casos-abertos`
- `20260101010410-finance-comissao-regra-reg-fin-001`
- `20260101010411-finance-extrato-fingerprint-unico`
- `20260101010412-finance-extrato-origem-confiavel`
- `20260101010520-m4lr-ledger-ddl-minimo`
- `20260101011400-m4pg-pagamento-estados-aprovacao-estorno-reabertura`
