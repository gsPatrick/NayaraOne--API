# Registro de decisões (ADR) do bloco de governança

Uma decisão por arquivo, formato: contexto, decisão, alternativas, consequências, data, responsável (M9-D891). Cobre as decisões K1 a K14 e as duplicidades de `Maturacao/demandas/marco-9/_correcoes-auditoria-parte3.md` e cada parâmetro de `_parametros-bloco-EF.csv` (padrão e origem). Decisão nova do bloco ganha o próximo número; decisões de implementação por demanda ficam em `Maturacao/demandas/decisoes-de-implementacao.md`.

| ADR | Título |
|---|---|
| [0001](0001-k1-ordem-x-dependencias.md) | K1 ordem x dependências |
| [0002](0002-k2-518-dias.md) | K2 "518 dias" |
| [0003](0003-k3-6-tipos-de-evento.md) | K3 "6 tipos de evento" |
| [0004](0004-k4-prefixo-gov.md) | K4 prefixo `GOV_` |
| [0005](0005-k5-corpo-de-erro.md) | K5 corpo de erro |
| [0006](0006-k6-marca-d-agua.md) | K6 marca d'água |
| [0007](0007-k7-numeracao-dos-formularios.md) | K7 numeração dos formulários |
| [0008](0008-k8-estados-do-lote.md) | K8 estados do lote |
| [0009](0009-k9-alertas-e-itens-do-sistema.md) | K9 alertas e itens do sistema |
| [0010](0010-k10-kind-do-export-job.md) | K10 `kind` do export_job |
| [0011](0011-k11-aprovacao-de-flag-critical.md) | K11 aprovação de flag CRITICAL |
| [0012](0012-k12-401-x-403.md) | K12 401 x 403 |
| [0013](0013-k13-readme.md) | K13 README |
| [0014](0014-k14-transicoes-do-indice.md) | K14 transições do índice |
| [0015](0015-duplicidade-expiracao-48-h-24-h-e-tetos.md) | Duplicidade: Expiração 48 h/24 h e tetos |
| [0016](0016-duplicidade-prod-nunca-desligado-por-custo.md) | Duplicidade: PROD nunca desligado por custo |
| [0017](0017-duplicidade-hold-bloqueia-descarte.md) | Duplicidade: Hold bloqueia descarte |
| [0018](0018-duplicidade-lineage-estrutura-e-semente.md) | Duplicidade: Lineage: estrutura e semente |
| [0019](0019-duplicidade-classe-padrao-high.md) | Duplicidade: Classe padrão HIGH |
| [0020](0020-duplicidade-marca-d-agua.md) | Duplicidade: Marca d'água |
| [0021](0021-duplicidade-cache-de-flag-de-30-s.md) | Duplicidade: Cache de flag de 30 s |
| [0022](0022-duplicidade-catalogo-dos-6-setores.md) | Duplicidade: Catálogo dos 6 setores |
| [0023](0023-duplicidade-janela-de-deprecacao-de-180-dias.md) | Duplicidade: Janela de deprecação de 180 dias |
| [0024](0024-duplicidade-evidencia-em-campo-critico.md) | Duplicidade: Evidência em campo crítico |
| [0025](0025-parametro-governanca-calendario-duracao-padrao-min.md) | Parâmetro governanca.calendario.duracao_padrao_min |
| [0026](0026-parametro-governanca-calendario-severidade-por-fonte.md) | Parâmetro governanca.calendario.severidade_por_fonte |
| [0027](0027-parametro-governanca-dados-dominios.md) | Parâmetro governanca.dados.dominios |
| [0028](0028-parametro-governanca-dados-merge-score-minimo.md) | Parâmetro governanca.dados.merge.score_minimo |
| [0029](0029-parametro-governanca-dados-campos-criticos.md) | Parâmetro governanca.dados.campos_criticos |
| [0030](0030-parametro-governanca-dlp-classificacao-padrao.md) | Parâmetro governanca.dlp.classificacao_padrao |
| [0031](0031-parametro-governanca-dlp-finalidades.md) | Parâmetro governanca.dlp.finalidades |
| [0032](0032-parametro-governanca-dlp-justificativa-min.md) | Parâmetro governanca.dlp.justificativa_min |
| [0033](0033-parametro-governanca-dlp-volume-teto-por-classe.md) | Parâmetro governanca.dlp.volume_teto_por_classe |
| [0034](0034-parametro-governanca-dlp-expiracao-horas-da-classe.md) | Parâmetro governanca.dlp.expiracao_horas_da_classe |
| [0035](0035-parametro-governanca-dlp-watermark-padrao-por-classe.md) | Parâmetro governanca.dlp.watermark.padrao_por_classe |
| [0036](0036-parametro-governanca-dlp-anomalia-limiares.md) | Parâmetro governanca.dlp.anomalia.limiares |
| [0037](0037-parametro-governanca-bcp-conciliar-pagamento-dias.md) | Parâmetro governanca.bcp.conciliar_pagamento_dias |
| [0038](0038-parametro-governanca-api-aviso-dias.md) | Parâmetro governanca.api.aviso_dias |
| [0039](0039-parametro-governanca-api-rate-limit.md) | Parâmetro governanca.api.rate_limit |
| [0040](0040-parametro-governanca-api-idempotencia-validade-horas.md) | Parâmetro governanca.api.idempotencia_validade_horas |
| [0041](0041-parametro-governanca-api-token-cliente-ttl-s.md) | Parâmetro governanca.api.token_cliente_ttl_s |
| [0042](0042-parametro-governanca-ui-exibir-debug.md) | Parâmetro governanca.ui.exibir_debug |
| [0043](0043-parametro-governanca-ui-confirmacao-por-nivel.md) | Parâmetro governanca.ui.confirmacao_por_nivel |
| [0044](0044-parametro-governanca-finops-moeda.md) | Parâmetro governanca.finops.moeda |
| [0045](0045-parametro-governanca-finops-orfao-dias.md) | Parâmetro governanca.finops.orfao_dias |
| [0046](0046-parametro-governanca-finops-log-x-media.md) | Parâmetro governanca.finops.log_x_media |
| [0047](0047-parametro-governanca-finops-fila-max.md) | Parâmetro governanca.finops.fila_max |
| [0048](0048-parametro-governanca-finops-fila-idade-min.md) | Parâmetro governanca.finops.fila_idade_min |
| [0049](0049-parametro-governanca-finops-ia-custo-chamada-centavos.md) | Parâmetro governanca.finops.ia_custo_chamada_centavos |
| [0050](0050-parametro-governanca-finops-egress-x-media.md) | Parâmetro governanca.finops.egress_x_media |
| [0051](0051-parametro-governanca-flags-kill-teste-dias.md) | Parâmetro governanca.flags.kill_teste_dias |
| [0052](0052-parametro-migracao-watermark-sobreposicao-s.md) | Parâmetro migracao.watermark.sobreposicao_s |
| [0053](0053-parametro-migracao-lote-tamanho.md) | Parâmetro migracao.lote.tamanho |
| [0054](0054-parametro-migracao-eta-janela-lotes.md) | Parâmetro migracao.eta.janela_lotes |
| [0055](0055-parametro-migracao-paralelo-intervalo-min.md) | Parâmetro migracao.paralelo.intervalo_min |
| [0056](0056-parametro-migracao-canary-etapas.md) | Parâmetro migracao.canary.etapas |
| [0057](0057-parametro-migracao-relogio-deriva-max-s.md) | Parâmetro migracao.relogio.deriva_max_s |
| [0058](0058-parametro-migracao-fuso-origem.md) | Parâmetro migracao.fuso_origem |
| [0059](0059-parametro-migracao-fuso-ambiguo.md) | Parâmetro migracao.fuso.ambiguo |
| [0060](0060-parametro-governanca-retencao-prazos-padrao.md) | Parâmetro governanca.retencao.prazos_padrao |
| [0061](0061-parametro-governanca-documentos-formato-codigo.md) | Parâmetro governanca.documentos.formato_codigo |
| [0062](0062-parametro-governanca-erros-excecoes-prefixo-gov.md) | Parâmetro governanca.erros.excecoes_prefixo_gov |
