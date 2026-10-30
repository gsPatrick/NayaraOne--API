# core-governance — Governança operacional (Marco 9, bloco E/F)

Feature em `src/features/core-governance` (decisão DI-ESTRUTURA-1: nunca existe `src/modules`; o que é feature fica em `src/features/<área>`), com a estrutura do livro (Guia do Marcelo §2). Oito subpastas, cada uma com `index.js` (exporta `router`, `service`, `events`), `*.routes.js`, `*.controller.js`, `*.service.js` e `README.md` com os 9 títulos fixos (M9-D891 confere o conteúdo).

| Subpasta | Prefixo de rota | Demandas |
|---|---|---|
| `calendar` | `/calendar` | M9-D801 a D803 |
| `data-quality` | `/data-quality` | M9-D804 a D808 |
| `lineage` | `/lineage` | M9-D810, D811 |
| `dlp` | `/dlp`, `/exports` | M9-D820 a D825 |
| `bcp` | `/bcp` | M9-D830 a D834 |
| `api-governance` | `/api-governance` | M9-D840 a D844 |
| `finops` | `/finops` | M9-D860 a D863 |
| `feature-flags` | `/feature-flags` | M9-D870 a D872 |

Arquivos comuns (na raiz, para a pasta continuar com exatamente 8 subpastas): `governance.errors.js` (corpo de erro único K5, prefixo `GOV_` K4), `governance.events.js` (catálogo fechado de 7 eventos), `governance.permissions.js` (21 permissões e concessão padrão), `governance.settings.js` (parâmetros do administrador), `governance.module.js` (fábrica de router com permissão e liga/desliga).

## Regras do alicerce
- Schema `governance`; toda tabela chama `governance.apply_tenant_rls('governance.<tabela>'::regclass)` na migration (RLS + FORCE RLS + política `tenant_isolation` + GRANT guardado por existência de `nayara_runtime`). Faixa de migrations do bloco E: `20260101000800` a `20260101000869`; do bloco F: `20260101000870` a `20260101000899`.
- Tudo que pode ser decidido pelo administrador é parâmetro (aba Governança em `/painel/configuracoes`): liga/desliga de cada módulo, lista de exceções ao prefixo `GOV_`, nomes dos perfis de Gestão e Financeiro para a concessão padrão.
- Ordem de construção: ver `Maturacao/demandas/marco-9/M9-D800-*.md` seção 3.5.

## Parâmetros transversais (M9-D891)
O liga/desliga de cada módulo é `governanca.modulos.<módulo>.habilitado` (listado no README de cada módulo). As chaves abaixo valem para o bloco inteiro; padrão = `Maturacao/demandas/parametros.csv`, alteração em /painel/configuracoes (aba Governança).

| Chave | Padrão | O que controla |
|---|---|---|
| `governanca.ui.cache_fresco_s` | `60` | até quantos segundos o último 200 de uma chamada conta como atual no estado OFFLINE do Front; passado disso a tela o marca "desatualizado" (M9-D850). |
| `governanca.ui.confirmacao_por_nivel` | `legal.contract.terminate=3; finance.entry.reverse=3; finance.payment_intent.cancel=3; procurement.order.cancel=2; property.delete=2; file.de` | nível de confirmação de cada ação destrutiva, `chave=nível; chave=nível` (1 simples, 2 com impacto, 3 crítica com código digitado). |
| `governanca.ui.exibir_debug` | `false` | corpo de erro 500 com o campo `debug` (mensagem e stack) fora de produção; desligado por padrão e proibido em produção (lido por `errorHandler`). |
| `governanca.acoes.impacto_validade_min` | `10` | minutos de validade do `impactToken` devolvido pela simulação de impacto. |
| `governanca.acoes.impacto_itens_max` | `50` | quantos itens afetados a tela lista no impacto de uma ação destrutiva. |
| `governanca.erros.excecoes_prefixo_gov` | `PERMISSION_DENIED, MISSING_ACCESS_TOKEN, MFA_STEP_UP_REQUIRED, MFA_REQUIRED_NOT_ENABLED, INTERNAL_ERROR, VALIDATION_ERROR` | códigos de erro da plataforma que ficam sem o prefixo `GOV_` (decisão K4). |
| `governanca.permissoes.perfis_gestao` | `GESTAO, GESTÃO, DIRETOR, GERENTE, GESTOR` | nomes dos perfis tratados como Gestão nas permissões do bloco. |
| `governanca.permissoes.perfis_financeiro` | `FINANCEIRO` | nomes dos perfis tratados como Financeiro nas permissões do bloco. |

Documentação do bloco: README de cada subpasta (as 9 seções fixas), decisões em `docs/governance/adr/` e runbooks operacionais em `docs/runbooks/governance/`.
