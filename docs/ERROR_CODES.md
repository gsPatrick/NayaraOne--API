# Catálogo de códigos de erro da API

Gerado por `node scripts/gerarErrorCatalog.js` a partir de `src/features/core-governance/api-governance/standards/errorCatalog.data.json`. Não edite à mão.

Corpo de erro único: `{"success":false,"error":{"code","message","details?","traceId"}}`; `traceId` é o `X-Correlation-Id` da requisição.

| Código | Status | Mensagem | Módulo | Desde | Descontinuado |
|---|---|---|---|---|---|
| `AUTH_VALIDATION` | 400 | Os dados de acesso enviados são inválidos. | plataforma | 1.1.0 | não |
| `GOV_ACTION_BLOCKED` | 409 | Não é possível continuar: há um impedimento. | governanca-ui | 1.3.0 | não |
| `GOV_ACTION_IMPACT_CHANGED` | 409 | O impacto mudou. Revise e confirme novamente. | governanca-ui | 1.3.0 | não |
| `GOV_ANOMALY_INVALID_TRANSITION` | 409 | Esta anomalia não pode mudar para a situação pedida. | dlp | 1.0.0 | não |
| `GOV_ANOMALY_REASON_REQUIRED` | 400 | Informe o motivo da revisão. | dlp | 1.0.0 | não |
| `GOV_API_CLIENT_INVALID` | 422 | Dados da credencial inválidos. | api-governance | 1.0.0 | não |
| `GOV_API_CLIENT_NOT_FOUND` | 404 | Credencial não encontrada. | api-governance | 1.0.0 | não |
| `GOV_API_CLIENT_REVOKED` | 409 | Esta credencial já foi revogada. | api-governance | 1.0.0 | não |
| `GOV_API_CONSUMER_EXISTS` | 409 | Já existe um consumidor com este nome ou esta credencial. | api-governance | 1.0.0 | não |
| `GOV_API_CONSUMER_INVALID` | 422 | Dados do consumidor inválidos. | api-governance | 1.0.0 | não |
| `GOV_API_DATE_INVALID` | 422 | Informe uma data válida (AAAA-MM-DD ou data e hora ISO). | api-governance | 1.0.0 | não |
| `GOV_API_DEPRECATION_EXISTS` | 409 | Já existe uma deprecação em andamento para este alvo. | api-governance | 1.0.0 | não |
| `GOV_API_DEPRECATION_FINAL` | 409 | Só uma deprecação anunciada pode ser cancelada. | api-governance | 1.0.0 | não |
| `GOV_API_DEPRECATION_INVALID` | 422 | A data de desligamento deve ser posterior ao anúncio. | api-governance | 1.0.0 | não |
| `GOV_API_OWNER_INVALID` | 422 | O responsável deve ser um usuário ativo da empresa. | api-governance | 1.0.0 | não |
| `GOV_API_OWNER_REQUIRED` | 422 | Informe o responsável pela deprecação. | api-governance | 1.0.0 | não |
| `GOV_API_REPLACEMENT_INVALID` | 422 | A substituta deve ser uma URL relativa iniciada por "/" com até 300 caracteres. | api-governance | 1.0.0 | não |
| `GOV_API_SUNSET_REQUIRED` | 422 | Informe a data de desligamento. | api-governance | 1.0.0 | não |
| `GOV_API_TARGET_INVALID` | 422 | Informe o alvo como "ROUTE:MÉTODO /caminho" ou "MAJOR:n". | api-governance | 1.0.0 | não |
| `GOV_API_VERSION_SUNSET` | 410 | Esta versão da API foi desativada. | api-governance | 1.0.0 | não |
| `GOV_ASSIGNEE_INACTIVE` | 422 | Só usuário ativo da empresa pode ser designado. | data-quality | 1.0.0 | não |
| `GOV_AUTH_INVALID_TOKEN_TYPE` | 401 | Tipo de credencial não aceito aqui. | api-governance | 1.0.0 | não |
| `GOV_BCP_ACTION_INVALID` | 422 | Esta ação não existe para o setor. | bcp | 1.0.0 | não |
| `GOV_BCP_ALREADY_FINAL` | 409 | Esta operação já foi concluída. | bcp | 1.0.0 | não |
| `GOV_BCP_COMMAND_REJECTED` | 422 | O sistema recusou a operação: <valor>. | bcp | 1.0.0 | não |
| `GOV_BCP_DATE_INVALID` | 422 | A data da operação é inválida. | bcp | 1.0.0 | não |
| `GOV_BCP_DECISION_NOTE_REQUIRED` | 400 | Informe a justificativa da decisão. | bcp | 1.0.0 | não |
| `GOV_BCP_EVIDENCE_REQUIRED` | 422 | Anexe a foto ou o escaneamento do formulário. | bcp | 1.0.0 | não |
| `GOV_BCP_FORM_NOT_FOUND` | 404 | Formulário não encontrado para este setor. | bcp | 1.0.0 | não |
| `GOV_BCP_NOT_EDITABLE` | 409 | Esta operação já foi importada e não pode ser editada. | bcp | 1.0.0 | não |
| `GOV_BCP_PAYLOAD_INVALID` | 422 | Os dados do formulário não passam nas regras do sistema. | bcp | 1.0.0 | não |
| `GOV_BCP_PAYMENT_DOUBLE_CHECK` | 422 | Pagamento manual exige conferência por duas pessoas diferentes. | bcp | 1.0.0 | não |
| `GOV_BCP_PAYMENT_SAME_PERSON` | 403 | As duas conferências devem ser de pessoas diferentes. | bcp | 1.0.0 | não |
| `GOV_BCP_RANGE_INVALID` | 400 | A faixa de folhas é inválida (máximo de <valor>). | bcp | 1.0.0 | não |
| `GOV_BCP_REFERENCE_DUPLICATE` | 409 | Este número de formulário já foi registrado. | bcp | 1.0.0 | não |
| `GOV_BCP_REFERENCE_INVALID` | 422 | O número do formulário é inválido para este setor. | bcp | 1.0.0 | não |
| `GOV_BCP_SECTOR_FORBIDDEN` | 403 | Você não pode <valor> deste setor. | bcp | 1.0.0 | não |
| `GOV_BUDGET_AMOUNT_INVALID` | 422 | O orçamento deve ser maior que zero. | finops | 1.3.0 | não |
| `GOV_BUDGET_DUPLICATE` | 409 | Já existe orçamento para este escopo. | finops | 1.3.0 | não |
| `GOV_BUDGET_NOT_FOUND` | 404 | Orçamento não encontrado. | finops | 1.3.0 | não |
| `GOV_BUDGET_OWNER_INVALID` | 422 | O responsável deve ser uma pessoa ativa desta empresa. | finops | 1.3.0 | não |
| `GOV_BUDGET_OWNER_REQUIRED` | 422 | Informe o responsável pelo orçamento. | finops | 1.3.0 | não |
| `GOV_BUDGET_SCOPE_INVALID` | 422 | O ambiente ou o domínio do orçamento não é válido. | finops | 1.3.0 | não |
| `GOV_BULK_FILTER_INVALID` | 400 | Filtro inválido. | data-quality | 1.0.0 | não |
| `GOV_BULK_TOO_LARGE` | 422 | O lote excede o limite de registros. | data-quality | 1.0.0 | não |
| `GOV_CALENDAR_EVENT_UNKNOWN` | 422 | Tipo de evento sem origem conhecida no calendário. | calendar | 1.0.0 | não |
| `GOV_CALENDAR_RANGE_INVALID` | 400 | A data inicial deve ser anterior à final. | calendar | 1.0.0 | não |
| `GOV_CALENDAR_SOURCE_INVALID` | 400 | Tipo de origem inválido. | calendar | 1.0.0 | não |
| `GOV_CALENDAR_TENANT_MISMATCH` | 403 | O evento pertence a outra empresa e foi descartado. | calendar | 1.0.0 | não |
| `GOV_CLASSIFICATION_MISSING` | 422 | A coluna não tem classificação no registro; vale a classe padrão. | data-quality | 1.3.0 | não |
| `GOV_CLASS_RETENTION_REQUIRED` | 422 | Informe a política de retenção. | data-quality | 1.3.0 | não |
| `GOV_CLIENT_DISABLED` | 401 | Esta credencial está desativada. | api-governance | 1.0.0 | não |
| `GOV_CODIGO_FORA_DO_PADRAO` | 500 | Código de erro fora do padrão GOV_ (o código original vai em details.codigoOriginal). | core-governance | 1.0.0 | não |
| `GOV_COMMITMENT_INVALID` | 400 | O fim do compromisso deve ser após o início. | calendar | 1.0.0 | não |
| `GOV_COMMITMENT_OWNER_ONLY` | 403 | Somente a pessoa responsável pelo compromisso ou um administrador pode fazer esta alteração. | calendar | 1.0.0 | não |
| `GOV_COMMITMENT_TRANSITION_INVALID` | 409 | Esta mudança de situação do compromisso não é permitida. | calendar | 1.0.0 | não |
| `GOV_CONFIRMATION_REQUIRED` | 422 | Confirme a ação digitando o código do registro. | governanca-ui | 1.3.0 | não |
| `GOV_CONFIRMATION_ROUTE_REQUIRED` | 422 | Para desativar o usuário use a ação Desativar, que mostra o impacto e pede confirmação. | governanca-ui | 1.3.0 | não |
| `GOV_CONTRACT_DB_NOT_DISPOSABLE` | 422 | O contract test só roda em banco descartável: <motivo>. | api-governance | 1.1.0 | não |
| `GOV_CONTRACT_EXAMPLE_INVALID` | 422 | O exemplo do contract test é inválido: <motivo>. | api-governance | 1.1.0 | não |
| `GOV_CONTRACT_EXAMPLE_MISSING` | 422 | Falta exemplo positivo ou negativo para <rota>. | api-governance | 1.1.0 | não |
| `GOV_DLP_DENIED` | 403 | Esta ação não é permitida para dados desta classificação. | dlp | 1.0.0 | não |
| `GOV_DLP_FLOOR_VIOLATION` | 422 | Esta classificação exige justificativa, verificação em duas etapas, auditoria e expiração. | dlp | 1.0.0 | não |
| `GOV_DLP_IDEMPOTENCY_CONFLICT` | 409 | Esta chave de idempotência já foi usada em outro pedido. | dlp | 1.0.0 | não |
| `GOV_DLP_PERMISSION` | 403 | Você não tem permissão para esta exportação. | core-governance | 1.0.0 | não |
| `GOV_DLP_POLICY_INVALID` | 400 | Classificação ou ação inválida. | dlp | 1.0.0 | não |
| `GOV_DLP_PURPOSE_REQUIRED` | 422 | Informe a finalidade e a justificativa para continuar. | core-governance | 1.0.0 | não |
| `GOV_DLP_REQUEST_INVALID` | 400 | Os dados do pedido de proteção de dados são inválidos. | dlp | 1.0.0 | não |
| `GOV_DLP_USER_SUSPENDED` | 403 | Suas exportações estão suspensas para revisão de segurança. | core-governance | 1.0.0 | não |
| `GOV_DLP_VOLUME_EXCEEDED` | 422 | O volume pedido excede o limite desta classificação. | core-governance | 1.0.0 | não |
| `GOV_DOMAIN_INVALID` | 400 | Domínio de dados inválido. | data-quality | 1.0.0 | não |
| `GOV_DOMAIN_OWNER_EXISTS` | 409 | Informe um único responsável (owner) por domínio. | data-quality | 1.0.0 | não |
| `GOV_DQ_FILTER_INVALID` | 400 | Filtro de qualidade inválido. | data-quality | 1.0.0 | não |
| `GOV_ERROR_CODE_INCOMPLETE` | 422 | Entrada incompleta no catálogo de erros: <código>. | core-governance | 1.0.0 | não |
| `GOV_ERROR_CODE_PREFIX` | 422 | Código fora do padrão GOV_: <código>. | core-governance | 1.0.0 | não |
| `GOV_ERROR_CODE_UNKNOWN` | 422 | Código de erro não catalogado: <código>. | core-governance | 1.0.0 | não |
| `GOV_EVENT_IDEMPOTENCY_REQUIRED` | 500 | Todo evento de governança exige idempotencyKey. | core-governance | 1.0.0 | não |
| `GOV_EVENT_UNKNOWN` | 500 | Tipo de evento fora do catálogo de governança. | core-governance | 1.0.0 | não |
| `GOV_EVIDENCE_FILE_REQUIRED` | 422 | Anexe o documento que comprova a alteração. | data-quality | 1.0.0 | não |
| `GOV_EVIDENCE_NOTE_TOO_SHORT` | 422 | Descreva a origem com pelo menos <valor> caracteres. | data-quality | 1.0.0 | não |
| `GOV_EVIDENCE_REQUIRED` | 422 | Informe a origem e o comprovante desta alteração. | data-quality | 1.0.0 | não |
| `GOV_EVIDENCE_SOURCE_INVALID` | 422 | Origem inválida para esta operação. | data-quality | 1.0.0 | não |
| `GOV_EXPORT_COLUMN_INVALID` | 400 | Coluna inválida para esta exportação. | dlp | 1.0.0 | não |
| `GOV_EXPORT_EXPIRED` | 410 | O arquivo expirou. Faça uma nova solicitação. | dlp | 1.0.0 | não |
| `GOV_EXPORT_FAILED` | 409 | A geração do arquivo falhou. Faça uma nova solicitação. | dlp | 1.0.0 | não |
| `GOV_EXPORT_FILTER_INVALID` | 400 | Filtro inválido para esta exportação. | dlp | 1.0.0 | não |
| `GOV_EXPORT_FORMAT_INVALID` | 400 | Formato inválido. | dlp | 1.0.0 | não |
| `GOV_EXPORT_GENERATION_FAILED` | 500 | A geração da exportação falhou. | core-governance | 1.0.0 | não |
| `GOV_EXPORT_LINK_INVALID` | 403 | Endereço de download inválido ou vencido. | dlp | 1.0.0 | não |
| `GOV_EXPORT_MOVED` | 410 | Esta exportação agora é pedida por POST /exports, com finalidade e justificativa. | dlp | 1.0.0 | não |
| `GOV_EXPORT_NOT_OWNER` | 403 | Este arquivo foi gerado para outra pessoa. | dlp | 1.0.0 | não |
| `GOV_EXPORT_NOT_READY` | 409 | O arquivo ainda está sendo gerado. | dlp | 1.0.0 | não |
| `GOV_EXPORT_PERMISSION_LOST` | 403 | A pessoa que pediu a exportação não tem mais a permissão necessária. | dlp | 1.0.0 | não |
| `GOV_EXPORT_REQUEST_INVALID` | 400 | Os dados do pedido de exportação são inválidos. | dlp | 1.0.0 | não |
| `GOV_EXPORT_RESOURCE_INVALID` | 400 | Tipo de exportação inválido. | dlp | 1.0.0 | não |
| `GOV_EXPORT_TIMEOUT` | 500 | A geração da exportação passou do tempo máximo. | core-governance | 1.0.0 | não |
| `GOV_EXTERNAL_LEAD_DUPLICATE` | 409 | Já existe um cadastro com este documento ou contato. | api-governance | 1.0.0 | não |
| `GOV_EXTERNAL_LEAD_INVALID` | 422 | Dados do lead inválidos. | api-governance | 1.0.0 | não |
| `GOV_EXTERNAL_ROUTE_WITHOUT_SCOPE` | 500 | Rota externa sem scope declarado. | api-governance | 1.0.0 | não |
| `GOV_FINOPS_AMOUNT_INVALID` | 422 | O valor do custo não pode ser negativo. | finops | 1.3.0 | não |
| `GOV_FINOPS_COLLECTOR_FAILED` | 500 | O coletor de custo "<valor>" falhou; nenhum valor foi gravado e o último sucesso continua exibido. | finops | 1.3.0 | não |
| `GOV_FINOPS_CRITICAL_NOT_DEGRADABLE` | 422 | Esta função é crítica e não pode ser degradada. | finops | 1.3.0 | não |
| `GOV_FINOPS_INVOICE_INVALID` | 422 | A fatura de custo não é válida. | finops | 1.3.0 | não |
| `GOV_FINOPS_LINE_INVALID` | 422 | A linha de custo não é válida. | finops | 1.3.0 | não |
| `GOV_FINOPS_PERIOD_OPEN` | 422 | A fatura só pode ser importada para um período já fechado. | finops | 1.3.0 | não |
| `GOV_FINOPS_POLICY_INVALID` | 422 | A política de degradação por custo é inválida. | finops | 1.3.0 | não |
| `GOV_FINOPS_PROD_PROTECTED` | 403 | O ambiente de produção não pode ser desligado por custo. | finops | 1.3.0 | não |
| `GOV_FLAG_DUPLICATE` | 409 | Já existe uma chave igual neste escopo. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_EXPIRED` | 422 | A chave expirou: estenda a validade para uma data futura para reativá-la. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_EXPIRY_REQUIRED` | 422 | Flag temporária precisa de data de expiração. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_INPUT_INVALID` | 422 | Algum campo da chave é inválido. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_NOT_FOUND` | 404 | Chave não encontrada. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_OWNER_INVALID` | 422 | O responsável deve ser uma pessoa ativa desta empresa. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_OWNER_REQUIRED` | 422 | Informe o responsável pela chave. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_REASON_REQUIRED` | 422 | Informe o motivo da alteração. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_SOURCE_LOCKED` | 422 | Esta configuração vem das Configurações da empresa: só valor, responsável, risco e descrição podem mudar aqui. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_VALIDITY_INVALID` | 422 | O fim da validade deve ser após o início. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_VALUE_INVALID` | 422 | O valor não corresponde ao tipo da chave. | feature-flags | 1.3.0 | não |
| `GOV_FLAG_VERSION_CONFLICT` | 409 | A chave foi alterada por outra pessoa. Recarregue e tente de novo. | feature-flags | 1.3.0 | não |
| `GOV_IDEMPOTENCY_KEY_INVALID` | 400 | A chave de idempotência deve ter de 8 a 128 caracteres. | api-governance | 1.0.0 | não |
| `GOV_IDEMPOTENCY_KEY_REQUIRED` | 400 | Envie o cabeçalho Idempotency-Key. | api-governance | 1.0.0 | não |
| `GOV_IDEMPOTENCY_KEY_REUSED` | 422 | Esta chave de idempotência já foi usada com outra requisição. | api-governance | 1.0.0 | não |
| `GOV_IDEMPOTENCY_RESPONSE_PENDING` | 409 | A requisição original ainda está em andamento ou não guardou a resposta. Tente de novo em instantes. | api-governance | 1.0.0 | não |
| `GOV_INSUFFICIENT_SCOPE` | 403 | A credencial não tem permissão para esta operação. | api-governance | 1.0.0 | não |
| `GOV_INVALID_CLIENT` | 401 | Credenciais inválidas. | api-governance | 1.0.0 | não |
| `GOV_INVALID_SCOPE` | 400 | Nenhum dos scopes pedidos é permitido para esta credencial. | api-governance | 1.0.0 | não |
| `GOV_KILL_DRILL_PROD_FORBIDDEN` | 403 | O teste automático não roda em produção. | feature-flags | 1.3.0 | não |
| `GOV_KILL_PROBE_REQUIRED` | 422 | Todo kill switch precisa de um teste automatizado. | feature-flags | 1.3.0 | não |
| `GOV_LINEAGE_AREA_INVALID` | 400 | Área de lineage inválida. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_AREA_MISSING` | 422 | Área sem lineage cadastrado. | core-governance | 1.0.0 | não |
| `GOV_LINEAGE_AREA_REQUIRED` | 422 | Informe a área do nó de lineage. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_CODE_INVALID` | 400 | Informe o código do nó (letras, números, ponto, dois-pontos, barra, hífen e sublinhado; até 200 caracteres). | lineage | 1.0.0 | não |
| `GOV_LINEAGE_CRITICALITY_INVALID` | 400 | Criticidade de lineage inválida. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_CRITICALITY_LOCKED` | 409 | Esta área exige lineage crítico. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_DESCRIPTION_REQUIRED` | 422 | Descreva o nó de lineage. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_EDGE_EXISTS` | 409 | Esta ligação de lineage já existe. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_LAYER_INVALID` | 422 | Esta ligação não respeita a ordem das camadas. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_MAP_DRIFT` | 422 | O mapa de migração e o lineage divergem. | core-governance | 1.0.0 | não |
| `GOV_LINEAGE_NODE_EXISTS` | 409 | Já existe um nó de lineage com este tipo e código. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_NODE_INCOMPLETE` | 422 | Nó de lineage incompleto: <código>. | core-governance | 1.0.0 | não |
| `GOV_LINEAGE_NODE_TYPE_INVALID` | 400 | Tipo de nó de lineage inválido. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_OWNER_REQUIRED` | 422 | Informe o domínio responsável pelo nó. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_SEED_CONFLICT` | 500 | Duas sementes de lineage definem o mesmo nó de formas diferentes. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_SEED_INVALID` | 500 | Semente de lineage inválida. | lineage | 1.0.0 | não |
| `GOV_LINEAGE_UNCOVERED` | 422 | KPI crítico sem lineage: <código>. | core-governance | 1.0.0 | não |
| `GOV_LINK_ALREADY_FINAL` | 409 | Este link já foi encerrado. | dlp | 1.0.0 | não |
| `GOV_LINK_EXPIRY_TOO_LONG` | 422 | O prazo máximo para esta classificação é de <valor> horas. | dlp | 1.0.0 | não |
| `GOV_LINK_NOT_OWNER` | 403 | Você não pode revogar este link. | dlp | 1.0.0 | não |
| `GOV_LINK_REQUEST_INVALID` | 400 | Os dados do pedido de link externo são inválidos. | dlp | 1.0.0 | não |
| `GOV_LINK_RESOURCE_INVALID` | 400 | Tipo de recurso inválido para compartilhar. | dlp | 1.0.0 | não |
| `GOV_LINK_RESOURCE_NOT_SHAREABLE` | 422 | Este recurso não pode ser compartilhado por link. | dlp | 1.0.0 | não |
| `GOV_LINK_UNAVAILABLE` | 404 | Link indisponível. | dlp | 1.0.0 | não |
| `GOV_LINK_WATERMARK_UNSUPPORTED` | 422 | Este tipo de arquivo não aceita a marca d'água exigida para esta classificação. | dlp | 1.0.0 | não |
| `GOV_MERGE_FIELD_CHOICE_REQUIRED` | 400 | Escolha o valor que fica em cada campo em conflito. | data-quality | 1.0.0 | não |
| `GOV_MERGE_REFERENCE_CONFLICT` | 409 | Não foi possível unir: um dado ligado aos dois cadastros entra em conflito ao ser unificado. Revise os cadastros. | data-quality | 1.0.0 | não |
| `GOV_MERGE_SURVIVOR_INVALID` | 400 | O registro mantido deve ser um dos dois do par. | data-quality | 1.0.0 | não |
| `GOV_MODULE_DISABLED` | 403 | Este módulo de governança está desativado pelo administrador. | core-governance | 1.0.0 | não |
| `GOV_NOT_DOMAIN_STEWARD` | 403 | Você não é responsável por este domínio. | data-quality | 1.0.0 | não |
| `GOV_NOT_FOUND` | 404 | Reconciliação não encontrada. | bcp | 1.0.0 | não |
| `GOV_OPENAPI_BREAKING_CHANGE` | 422 | Mudança incompatível dentro da major <valor>: <regra> em <caminho>. | core-governance | 1.0.0 | não |
| `GOV_OPENAPI_INVALID` | 422 | O contrato OpenAPI é inválido: <valor>. | api-governance | 1.0.0 | não |
| `GOV_OPENAPI_ROUTE_UNDOCUMENTED` | 422 | Rota sem documentação no contrato: <método> <caminho>. | core-governance | 1.0.0 | não |
| `GOV_QUEUE_DECISION_INVALID` | 400 | Decisão inválida para este item. | data-quality | 1.0.0 | não |
| `GOV_QUEUE_ITEM_FINAL` | 409 | Este item já foi decidido. | data-quality | 1.0.0 | não |
| `GOV_RATE_LIMITED` | 429 | Muitas requisições. Tente novamente em <N> segundos. | api-governance | 1.0.0 | não |
| `GOV_RESPONSE_SCHEMA_MISMATCH` | 422 | A resposta de <método> <rota> não segue o contrato. | api-governance | 1.1.0 | não |
| `GOV_STATUS_NOT_DOCUMENTED` | 422 | Status <N> não está no contrato de <rota>. | api-governance | 1.1.0 | não |
| `GOV_TOKEN_EXPIRED` | 401 | O token expirou. Obtenha um novo token. | api-governance | 1.0.0 | não |
| `GOV_RETENTION_ALL_HELD` | 409 | Todos os registros desta rodada estão sob bloqueio legal (legal hold). | data-quality | 1.3.0 | não |
| `GOV_RETENTION_ALREADY_APPLIED` | 409 | Esta rodada de retenção já foi aplicada. | data-quality | 1.3.0 | não |
| `GOV_RETENTION_APPLY_FAILED` | 500 | A aplicação parou num lote; os lotes concluídos foram mantidos e o restante pode ser retomado. | data-quality | 1.3.0 | não |
| `GOV_RETENTION_AUTO_APPLY_UNSAFE` | 422 | A aplicação automática só vale para dados técnicos de integração. | data-quality | 1.3.0 | não |
| `GOV_RETENTION_DISPOSITION_UNSUPPORTED` | 422 | O tipo de dado não aceita esta disposição. | data-quality | 1.3.0 | não |
| `GOV_RETENTION_DRY_RUN_REQUIRED` | 409 | Execute a simulação antes de aplicar. | data-quality | 1.3.0 | não |
| `GOV_RETENTION_HOLD_EXCEPTION_REQUIRED` | 422 | Toda política deve respeitar a retenção legal (legal hold). | data-quality | 1.3.0 | não |
| `GOV_RETENTION_LEGAL_BASIS_INVALID` | 422 | A base legal informada não existe no catálogo. | data-quality | 1.3.0 | não |
| `GOV_RETENTION_LEGAL_BASIS_REQUIRED` | 422 | Informe a base legal da política de retenção. | data-quality | 1.3.0 | não |
| `GOV_RETENTION_PERIOD_INVALID` | 422 | O prazo de retenção é inválido. | data-quality | 1.3.0 | não |
| `GOV_RETENTION_RUN_IN_PROGRESS` | 409 | Esta rodada de retenção está sendo aplicada agora. | data-quality | 1.3.0 | não |
| `GOV_RETENTION_TARGET_TAKEN` | 409 | Este tipo de dado já pertence a outra política de retenção. | data-quality | 1.3.0 | não |
| `GOV_RETENTION_TRIGGER_UNSUPPORTED` | 422 | O tipo de dado não aceita este gatilho. | data-quality | 1.3.0 | não |
| `GOV_TOKEN_INVALID` | 401 | Token de acesso inválido. | api-governance | 1.0.0 | não |
| `GOV_UNSUPPORTED_GRANT_TYPE` | 400 | Informe grant_type=client_credentials. | api-governance | 1.0.0 | não |
| `GOV_VALIDATION_PAGINATION` | 400 | Parâmetros de paginação inválidos. | api-governance | 1.0.0 | não |
| `INTERNAL_ERROR` | 500 | Erro interno. | plataforma | 1.0.0 | não |
| `LEGAL_INSPECTION_IMMUTABLE_AFTER_SIGNATURE` | 409 | Esta vistoria já tem assinatura registrada e ficou imutável. | legal | 1.0.0 | não |
| `MFA_REQUIRED_NOT_ENABLED` | 403 | Ative a verificação em duas etapas para continuar. | plataforma | 1.0.0 | não |
| `MFA_STEP_UP_REQUIRED` | 403 | Confirme sua identidade com o código de verificação em duas etapas. | plataforma | 1.0.0 | não |
| `MISSING_ACCESS_TOKEN` | 401 | Token de acesso ausente. | plataforma | 1.0.0 | não |
| `MKT_PAGE_GONE` | 410 | Esta página não está mais disponível. | marketing | 1.3.0 | não |
| `MKT_PAGE_NOT_FOUND` | 404 | Página não encontrada. | marketing | 1.3.0 | não |
| `PERMISSION_DENIED` | 403 | Você não tem permissão para realizar esta ação. | plataforma | 1.0.0 | não |
| `ROUTE_NOT_FOUND` | 404 | Rota não encontrada. | plataforma | 1.3.0 | não |
| `VALIDATION_ERROR` | 400 | Os dados enviados são inválidos. | plataforma | 1.0.0 | não |
