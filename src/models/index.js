'use strict';

const { Sequelize } = require('sequelize');
const sequelizeConfig = require('../config/database');

const sequelize = sequelizeConfig.sequelize;

const modelDefiners = {
  Group: require('./Group'),
  Company: require('./Company'),
  Unit: require('./Unit'),
  User: require('./User'),
  UserMembership: require('./UserMembership'),
  Session: require('./Session'),
  Role: require('./Role'),
  Permission: require('./Permission'),
  RolePermission: require('./RolePermission'),
  Substitution: require('./Substitution'),
  Task: require('./Task'),
  Notification: require('./Notification'),
  SystemSetting: require('./SystemSetting'),
  Rule: require('./Rule'),
  RuleVersion: require('./RuleVersion'),
  RuleScope: require('./RuleScope'),
  RuleDependency: require('./RuleDependency'),
  RuleException: require('./RuleException'),
  RuleApprovalRequest: require('./RuleApprovalRequest'),
  RuleApprovalStep: require('./RuleApprovalStep'),
  RulePublication: require('./RulePublication'),
  RuleSimulation: require('./RuleSimulation'),
  RuleTestCase: require('./RuleTestCase'),
  RuleEvaluationLog: require('./RuleEvaluationLog'),
  Person: require('./Person'),
  PersonRole: require('./PersonRole'),
  PersonContact: require('./PersonContact'),
  PersonDocument: require('./PersonDocument'),
  PersonAddress: require('./PersonAddress'),
  CommunicationConsent: require('./CommunicationConsent'),
  File: require('./File'),
  FileLink: require('./FileLink'),
  Property: require('./Property'),
  PropertyAddress: require('./PropertyAddress'),
  PropertyOwner: require('./PropertyOwner'),
  PropertyOffer: require('./PropertyOffer'),
  PropertyPriceHistory: require('./PropertyPriceHistory'),
  PropertyMedia: require('./PropertyMedia'),
  PropertyDocument: require('./PropertyDocument'),
  PropertyInternalOccurrence: require('./PropertyInternalOccurrence'),
  Opportunity: require('./Opportunity'),
  PropertyRadar: require('./PropertyRadar'),
  Visit: require('./Visit'),
  Message: require('./Message'),
  Contract: require('./Contract'),
  ContractParty: require('./ContractParty'),
  ContractVersion: require('./ContractVersion'),
  Signature: require('./Signature'),
  LegalCase: require('./LegalCase'),
  LegalDeadline: require('./LegalDeadline'),
  Inspection: require('./Inspection'),
  InspectionItem: require('./InspectionItem'),
  Guarantee: require('./Guarantee'),
  KeyDelivery: require('./KeyDelivery'),
  EvidencePackage: require('./EvidencePackage'),
  InsuranceCase: require('./InsuranceCase'),
  BankAccount: require('./BankAccount'),
  CostCenter: require('./CostCenter'),
  ResultCenter: require('./ResultCenter'),
  FinancialEntry: require('./FinancialEntry'),
  BankTransaction: require('./BankTransaction'),
  Reconciliation: require('./Reconciliation'),
  ApprovalRequest: require('./ApprovalRequest'),
  ApprovalStep: require('./ApprovalStep'),
  Commission: require('./Commission'),
  CommissionInstallment: require('./CommissionInstallment'),
  OwnerRepass: require('./OwnerRepass'),
  TaxDocument: require('./TaxDocument'),
  Project: require('./Project'),
  ProjectStage: require('./ProjectStage'),
  MaintenanceCase: require('./MaintenanceCase'),
  StageMeasurement: require('./StageMeasurement'),
  DailyReport: require('./DailyReport'),
  BudgetLine: require('./BudgetLine'),
  QualityChecklistItem: require('./QualityChecklistItem'),
  InventoryItem: require('./InventoryItem'),
  InventoryMovement: require('./InventoryMovement'),
  Asset: require('./Asset'),
  OutboxEvent: require('./OutboxEvent'),
  IntegrationInbox: require('./IntegrationInbox'),
  DomainEvent: require('./DomainEvent'),
  AiRun: require('./AiRun'),
  AiSource: require('./AiSource'),
  KnowledgeEntry: require('./KnowledgeEntry'),
  AiRecommendation: require('./AiRecommendation'),
  AuditLog: require('./AuditLog'),
};

const db = { sequelize, Sequelize };

for (const [name, definer] of Object.entries(modelDefiners)) {
  db[name] = definer(sequelize);
}

/**
 * Associações inferidas a partir das FKs documentadas (ver src/documentacao/models/*.md
 * para a lista de inferências de modelagem que não estavam explícitas nas fontes).
 * constraints:false porque as constraints físicas de FK já são criadas nas migrations
 * (podendo referenciar colunas de outros schemas Postgres); aqui definimos apenas a
 * associação lógica do Sequelize para uso em include/eager-loading.
 */
  db.Company.belongsTo(db.Group, { foreignKey: 'group_id', as: 'group', constraints: false });
  db.Unit.belongsTo(db.Company, { foreignKey: 'company_id', as: 'company', constraints: false });
  db.Unit.belongsTo(db.Group, { foreignKey: 'group_id', as: 'group', constraints: false });
  db.Session.belongsTo(db.User, { foreignKey: 'user_id', as: 'user', constraints: false });
  db.UserMembership.belongsTo(db.Company, { foreignKey: 'company_id', as: 'company', constraints: false });
  db.UserMembership.belongsTo(db.Group, { foreignKey: 'group_id', as: 'group', constraints: false });
  db.UserMembership.belongsTo(db.Role, { foreignKey: 'role_id', as: 'role', constraints: false });
  db.Role.belongsTo(db.Company, { foreignKey: 'company_id', as: 'company', constraints: false });
  db.Role.belongsTo(db.Group, { foreignKey: 'group_id', as: 'group', constraints: false });
  db.UserMembership.belongsTo(db.User, { foreignKey: 'user_id', as: 'user', constraints: false });
  db.UserMembership.belongsTo(db.Unit, { foreignKey: 'unit_id', as: 'unit', constraints: false });
  db.RolePermission.belongsTo(db.Role, { foreignKey: 'role_id', as: 'role', constraints: false });
  db.RolePermission.belongsTo(db.Permission, { foreignKey: 'permission_id', as: 'permission', constraints: false });
  db.Role.hasMany(db.RolePermission, { foreignKey: 'role_id', as: 'rolePermissions', constraints: false });
  db.Role.hasMany(db.UserMembership, { foreignKey: 'role_id', as: 'memberships', constraints: false });
  db.Substitution.belongsTo(db.User, { foreignKey: 'substitute_user_id', as: 'substituteUser', constraints: false });
  db.Substitution.belongsTo(db.User, { foreignKey: 'original_user_id', as: 'originalUser', constraints: false });
  db.Task.belongsTo(db.User, { foreignKey: 'assigned_to_user_id', as: 'assignedToUser', constraints: false });
  db.Notification.belongsTo(db.User, { foreignKey: 'user_id', as: 'user', constraints: false });
  db.RuleVersion.belongsTo(db.Rule, { foreignKey: 'rule_id', as: 'rule', constraints: false });
  db.RuleVersion.belongsTo(db.User, { foreignKey: 'published_by_user_id', as: 'publishedByUser', constraints: false });
  db.RuleScope.belongsTo(db.RuleVersion, { foreignKey: 'rule_version_id', as: 'ruleVersion', constraints: false });
  db.RuleDependency.belongsTo(db.Rule, { foreignKey: 'rule_id', as: 'rule', constraints: false });
  db.RuleDependency.belongsTo(db.Rule, { foreignKey: 'depends_on_rule_id', as: 'dependsOnRule', constraints: false });
  db.RuleException.belongsTo(db.Rule, { foreignKey: 'rule_id', as: 'rule', constraints: false });
  db.RuleException.belongsTo(db.User, { foreignKey: 'approved_by_user_id', as: 'approvedByUser', constraints: false });
  db.RuleApprovalRequest.belongsTo(db.RuleVersion, { foreignKey: 'rule_version_id', as: 'ruleVersion', constraints: false });
  db.RuleApprovalRequest.belongsTo(db.User, { foreignKey: 'requested_by_user_id', as: 'requestedByUser', constraints: false });
  db.RuleApprovalStep.belongsTo(db.RuleApprovalRequest, { foreignKey: 'rule_approval_request_id', as: 'ruleApprovalRequest', constraints: false });
  db.RuleApprovalStep.belongsTo(db.User, { foreignKey: 'approver_user_id', as: 'approverUser', constraints: false });
  db.RulePublication.belongsTo(db.RuleVersion, { foreignKey: 'rule_version_id', as: 'ruleVersion', constraints: false });
  db.RulePublication.belongsTo(db.User, { foreignKey: 'published_by_user_id', as: 'publishedByUser', constraints: false });
  db.RuleSimulation.belongsTo(db.RuleVersion, { foreignKey: 'rule_version_id', as: 'ruleVersion', constraints: false });
  db.RuleSimulation.belongsTo(db.User, { foreignKey: 'requested_by_user_id', as: 'requestedByUser', constraints: false });
  db.RuleTestCase.belongsTo(db.Rule, { foreignKey: 'rule_id', as: 'rule', constraints: false });
  db.RuleEvaluationLog.belongsTo(db.RuleVersion, { foreignKey: 'rule_version_id', as: 'ruleVersion', constraints: false });
  db.PersonRole.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.PersonContact.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.PersonDocument.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.Person.hasMany(db.PersonRole, { foreignKey: 'person_id', as: 'roles', constraints: false });
  db.Person.hasMany(db.PersonContact, { foreignKey: 'person_id', as: 'contacts', constraints: false });
  db.Person.hasMany(db.PersonDocument, { foreignKey: 'person_id', as: 'documents', constraints: false });
  db.PersonAddress.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.Person.hasMany(db.PersonAddress, { foreignKey: 'person_id', as: 'addresses', constraints: false });
  db.CommunicationConsent.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.Person.hasMany(db.CommunicationConsent, { foreignKey: 'person_id', as: 'communicationConsents', constraints: false });
  db.Person.belongsTo(db.Person, { foreignKey: 'merged_into_id', as: 'mergedInto', constraints: false });
  db.Person.hasMany(db.Person, { foreignKey: 'merged_into_id', as: 'mergedFrom', constraints: false });
  db.File.belongsTo(db.User, { foreignKey: 'uploaded_by_user_id', as: 'uploadedByUser', constraints: false });
  db.FileLink.belongsTo(db.File, { foreignKey: 'file_id', as: 'file', constraints: false });
  db.Property.belongsTo(db.PropertyAddress, { foreignKey: 'address_id', as: 'address', constraints: false });
  db.PropertyOwner.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.PropertyOwner.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.PropertyOffer.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.PropertyPriceHistory.belongsTo(db.PropertyOffer, { foreignKey: 'offer_id', as: 'offer', constraints: false });
  db.PropertyPriceHistory.belongsTo(db.User, { foreignKey: 'changed_by', as: 'changedByUser', constraints: false });
  db.PropertyMedia.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.PropertyDocument.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.PropertyInternalOccurrence.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.Opportunity.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.Opportunity.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.Opportunity.belongsTo(db.User, { foreignKey: 'owner_user_id', as: 'ownerUser', constraints: false });
  db.PropertyRadar.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.PropertyRadar.belongsTo(db.Opportunity, { foreignKey: 'opportunity_id', as: 'opportunity', constraints: false });
  db.Visit.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.Visit.belongsTo(db.Opportunity, { foreignKey: 'opportunity_id', as: 'opportunity', constraints: false });
  db.Visit.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.Visit.belongsTo(db.User, { foreignKey: 'agent_user_id', as: 'agentUser', constraints: false });
  db.Message.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.Message.belongsTo(db.Opportunity, { foreignKey: 'opportunity_id', as: 'opportunity', constraints: false });
  db.Message.belongsTo(db.User, { foreignKey: 'author_user_id', as: 'authorUser', constraints: false });
  db.Property.hasMany(db.PropertyOwner, { foreignKey: 'property_id', as: 'owners', constraints: false });
  db.Property.hasMany(db.PropertyOffer, { foreignKey: 'property_id', as: 'offers', constraints: false });
  db.Property.hasMany(db.PropertyMedia, { foreignKey: 'property_id', as: 'media', constraints: false });
  db.Property.hasMany(db.PropertyDocument, { foreignKey: 'property_id', as: 'documents', constraints: false });
  db.Property.hasMany(db.PropertyInternalOccurrence, { foreignKey: 'property_id', as: 'internalOccurrences', constraints: false });
  db.PropertyOffer.hasMany(db.PropertyPriceHistory, { foreignKey: 'offer_id', as: 'priceHistory', constraints: false });
  db.Opportunity.hasMany(db.Visit, { foreignKey: 'opportunity_id', as: 'visits', constraints: false });
  db.Opportunity.hasMany(db.Message, { foreignKey: 'opportunity_id', as: 'messages', constraints: false });
  db.Opportunity.hasMany(db.PropertyRadar, { foreignKey: 'opportunity_id', as: 'radars', constraints: false });
  db.Contract.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.Contract.belongsTo(db.Opportunity, { foreignKey: 'opportunity_id', as: 'opportunity', constraints: false });
  db.ContractParty.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.ContractParty.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.ContractVersion.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.ContractVersion.belongsTo(db.File, { foreignKey: 'document_file_id', as: 'documentFile', constraints: false });
  db.Signature.belongsTo(db.ContractVersion, { foreignKey: 'contract_version_id', as: 'contractVersion', constraints: false });
  db.Signature.belongsTo(db.Person, { foreignKey: 'person_id', as: 'person', constraints: false });
  db.LegalCase.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.LegalCase.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.LegalCase.belongsTo(db.User, { foreignKey: 'responsible_user_id', as: 'responsibleUser', constraints: false });
  db.LegalDeadline.belongsTo(db.LegalCase, { foreignKey: 'legal_case_id', as: 'legalCase', constraints: false });
  db.Inspection.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.Inspection.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.Inspection.belongsTo(db.User, { foreignKey: 'inspector_user_id', as: 'inspectorUser', constraints: false });
  db.InspectionItem.belongsTo(db.Inspection, { foreignKey: 'inspection_id', as: 'inspection', constraints: false });
  db.Guarantee.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.Guarantee.belongsTo(db.Person, { foreignKey: 'guarantor_person_id', as: 'guarantorPerson', constraints: false });
  db.KeyDelivery.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.KeyDelivery.belongsTo(db.Inspection, { foreignKey: 'inspection_id', as: 'inspection', constraints: false });
  db.KeyDelivery.belongsTo(db.Person, { foreignKey: 'delivered_to_person_id', as: 'deliveredToPerson', constraints: false });
  db.KeyDelivery.belongsTo(db.User, { foreignKey: 'delivered_by_user_id', as: 'deliveredByUser', constraints: false });
  db.EvidencePackage.belongsTo(db.LegalCase, { foreignKey: 'legal_case_id', as: 'legalCase', constraints: false });
  db.InsuranceCase.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.InsuranceCase.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.BankAccount.belongsTo(db.Person, { foreignKey: 'owner_person_id', as: 'ownerPerson', constraints: false });
  db.FinancialEntry.belongsTo(db.BankAccount, { foreignKey: 'bank_account_id', as: 'bankAccount', constraints: false });
  db.FinancialEntry.belongsTo(db.CostCenter, { foreignKey: 'cost_center_id', as: 'costCenter', constraints: false });
  db.FinancialEntry.belongsTo(db.ResultCenter, { foreignKey: 'result_center_id', as: 'resultCenter', constraints: false });
  db.FinancialEntry.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.BankTransaction.belongsTo(db.BankAccount, { foreignKey: 'bank_account_id', as: 'bankAccount', constraints: false });
  db.Reconciliation.belongsTo(db.FinancialEntry, { foreignKey: 'financial_entry_id', as: 'financialEntry', constraints: false });
  db.Reconciliation.belongsTo(db.BankTransaction, { foreignKey: 'bank_transaction_id', as: 'bankTransaction', constraints: false });
  db.Reconciliation.belongsTo(db.User, { foreignKey: 'matched_by_user_id', as: 'matchedByUser', constraints: false });
  db.ApprovalRequest.belongsTo(db.User, { foreignKey: 'requested_by_user_id', as: 'requestedByUser', constraints: false });
  db.ApprovalStep.belongsTo(db.ApprovalRequest, { foreignKey: 'approval_request_id', as: 'approvalRequest', constraints: false });
  db.ApprovalStep.belongsTo(db.User, { foreignKey: 'approver_user_id', as: 'approverUser', constraints: false });
  db.Commission.belongsTo(db.Opportunity, { foreignKey: 'opportunity_id', as: 'opportunity', constraints: false });
  db.Commission.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.Commission.belongsTo(db.User, { foreignKey: 'beneficiary_user_id', as: 'beneficiaryUser', constraints: false });
  db.CommissionInstallment.belongsTo(db.Commission, { foreignKey: 'commission_id', as: 'commission', constraints: false });
  db.CommissionInstallment.belongsTo(db.FinancialEntry, { foreignKey: 'financial_entry_id', as: 'financialEntry', constraints: false });
  db.OwnerRepass.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.OwnerRepass.belongsTo(db.Person, { foreignKey: 'owner_person_id', as: 'ownerPerson', constraints: false });
  db.OwnerRepass.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.OwnerRepass.belongsTo(db.BankAccount, { foreignKey: 'bank_account_id', as: 'bankAccount', constraints: false });
  db.TaxDocument.belongsTo(db.Contract, { foreignKey: 'contract_id', as: 'contract', constraints: false });
  db.TaxDocument.belongsTo(db.FinancialEntry, { foreignKey: 'financial_entry_id', as: 'financialEntry', constraints: false });
  db.TaxDocument.belongsTo(db.File, { foreignKey: 'file_id', as: 'file', constraints: false });
  db.Project.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.Project.belongsTo(db.User, { foreignKey: 'responsible_user_id', as: 'responsibleUser', constraints: false });
  db.ProjectStage.belongsTo(db.Project, { foreignKey: 'project_id', as: 'project', constraints: false });
  db.MaintenanceCase.belongsTo(db.Property, { foreignKey: 'property_id', as: 'property', constraints: false });
  db.MaintenanceCase.belongsTo(db.Project, { foreignKey: 'project_id', as: 'project', constraints: false });
  db.MaintenanceCase.belongsTo(db.Person, { foreignKey: 'opened_by_person_id', as: 'openedByPerson', constraints: false });
  db.MaintenanceCase.belongsTo(db.User, { foreignKey: 'responsible_user_id', as: 'responsibleUser', constraints: false });
  db.Project.hasMany(db.ProjectStage, { foreignKey: 'project_id', as: 'stages', constraints: false });
  db.Project.hasMany(db.DailyReport, { foreignKey: 'project_id', as: 'dailyReports', constraints: false });
  db.Project.hasMany(db.BudgetLine, { foreignKey: 'project_id', as: 'budgetLines', constraints: false });
  db.Project.hasMany(db.QualityChecklistItem, { foreignKey: 'project_id', as: 'qualityItems', constraints: false });
  db.ProjectStage.hasMany(db.StageMeasurement, { foreignKey: 'project_stage_id', as: 'measurements', constraints: false });
  db.StageMeasurement.belongsTo(db.ProjectStage, { foreignKey: 'project_stage_id', as: 'stage', constraints: false });
  db.StageMeasurement.belongsTo(db.User, { foreignKey: 'measured_by_user_id', as: 'measuredByUser', constraints: false });
  db.StageMeasurement.belongsTo(db.User, { foreignKey: 'approved_by_user_id', as: 'approvedByUser', constraints: false });
  db.DailyReport.belongsTo(db.Project, { foreignKey: 'project_id', as: 'project', constraints: false });
  db.DailyReport.belongsTo(db.User, { foreignKey: 'reported_by_user_id', as: 'reportedByUser', constraints: false });
  db.BudgetLine.belongsTo(db.Project, { foreignKey: 'project_id', as: 'project', constraints: false });
  db.BudgetLine.belongsTo(db.CostCenter, { foreignKey: 'cost_center_id', as: 'costCenter', constraints: false });
  db.QualityChecklistItem.belongsTo(db.Project, { foreignKey: 'project_id', as: 'project', constraints: false });
  db.QualityChecklistItem.belongsTo(db.ProjectStage, { foreignKey: 'project_stage_id', as: 'stage', constraints: false });
  db.QualityChecklistItem.belongsTo(db.User, { foreignKey: 'checked_by_user_id', as: 'checkedByUser', constraints: false });
  db.InventoryMovement.belongsTo(db.InventoryItem, { foreignKey: 'inventory_item_id', as: 'inventoryItem', constraints: false });
  db.InventoryMovement.belongsTo(db.Project, { foreignKey: 'project_id', as: 'project', constraints: false });
  db.InventoryMovement.belongsTo(db.User, { foreignKey: 'moved_by_user_id', as: 'movedByUser', constraints: false });
  db.Asset.belongsTo(db.User, { foreignKey: 'assigned_to_user_id', as: 'assignedToUser', constraints: false });
  db.Asset.belongsTo(db.Project, { foreignKey: 'project_id', as: 'project', constraints: false });
  db.AiRun.belongsTo(db.User, { foreignKey: 'user_id', as: 'user', constraints: false });
  db.AiSource.belongsTo(db.AiRun, { foreignKey: 'ai_run_id', as: 'aiRun', constraints: false });
  db.AiRecommendation.belongsTo(db.AiRun, { foreignKey: 'ai_run_id', as: 'aiRun', constraints: false });
  db.AiRecommendation.belongsTo(db.User, { foreignKey: 'decided_by_user_id', as: 'decidedByUser', constraints: false });
  db.AuditLog.belongsTo(db.User, { foreignKey: 'user_id', as: 'user', constraints: false });

module.exports = db;
