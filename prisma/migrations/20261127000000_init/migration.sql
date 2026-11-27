-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPERADMIN', 'ADMIN', 'SUPERVISOR', 'SELLER');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('PURCHASE', 'INITIAL', 'SALE', 'SALE_VOID', 'RETURN', 'ADJUSTMENT', 'COUNT', 'WASTE', 'TRANSFER_OUT', 'TRANSFER_IN');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('REQUESTED', 'APPROVED', 'SHIPPED', 'RECEIVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdjustmentKind" AS ENUM ('ADJUSTMENT', 'WASTE', 'COUNT');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'YAPE', 'PLIN', 'CARD', 'TRANSFER', 'VOUCHER');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessType" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "features" JSONB NOT NULL,
    "aiUsageResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspendedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "extraPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" TEXT,
    "actorId" TEXT,
    "actorEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantBackup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantBackup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModelPrice" (
    "model" TEXT NOT NULL,
    "inputPerMTok" DECIMAL(12,4) NOT NULL,
    "outputPerMTok" DECIMAL(12,4) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModelPrice_pkey" PRIMARY KEY ("model")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSettings" (
    "tenantId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "legalName" TEXT NOT NULL DEFAULT '',
    "taxId" TEXT NOT NULL DEFAULT '',
    "ticketFooter" TEXT NOT NULL DEFAULT '¡Gracias por su compra!',
    "expiryDaysAhead" INTEGER NOT NULL DEFAULT 30,
    "alertExpiredEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertExpiringEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertLowStockEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maxSellerDiscountPct" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "labelFormat" JSONB NOT NULL,

    CONSTRAINT "TenantSettings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "Counter" (
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("tenantId","key")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBranch" (
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,

    CONSTRAINT "UserBranch_pkey" PRIMARY KEY ("tenantId","userId","branchId")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tracksExpiry" BOOLEAN NOT NULL DEFAULT false,
    "attributes" JSONB NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "tracksExpiry" BOOLEAN NOT NULL DEFAULT false,
    "attributes" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "attributes" JSONB NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "minStock" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "changedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "lotId" TEXT,
    "type" "MovementType" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '',
    "userId" TEXT NOT NULL,
    "refType" TEXT NOT NULL DEFAULT '',
    "refId" TEXT NOT NULL DEFAULT '',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "lotKey" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("tenantId","branchId","variantId","lotKey")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncOperation" (
    "tenantId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "result" JSONB,
    "clientTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("tenantId","id")
);

-- CreateTable
CREATE TABLE "CashSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "openingAmount" DECIMAL(12,2) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "expected" JSONB,
    "counted" JSONB,
    "difference" DECIMAL(12,2),
    "notes" TEXT NOT NULL DEFAULT '',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "CashSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cashSessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT,
    "cashSessionId" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "voidReason" TEXT,
    "voidedBy" TEXT,
    "voidedAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "returnedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,

    CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "cashSessionId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleReturn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "refundMethod" "PaymentMethod" NOT NULL,
    "reason" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaleReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voucher" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL,
    "returnId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromBranchId" TEXT NOT NULL,
    "toBranchId" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "notes" TEXT NOT NULL DEFAULT '',
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "shippedBy" TEXT,
    "shippedAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "requested" DECIMAL(12,3) NOT NULL,
    "shippedLots" JSONB,
    "shipped" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "received" DECIMAL(12,3) NOT NULL DEFAULT 0,

    CONSTRAINT "TransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Adjustment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "kind" "AdjustmentKind" NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "Adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "supplierRuc" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "igv" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "issueDate" TEXT NOT NULL DEFAULT '',
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorNotice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "SupervisorNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SunatConfig" (
    "tenantId" TEXT NOT NULL,
    "ruc" TEXT NOT NULL,
    "solUser" TEXT NOT NULL,
    "solPasswordEnc" TEXT NOT NULL,
    "certificateEnc" TEXT NOT NULL,
    "certPasswordEnc" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'BETA',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SunatConfig_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "ElectronicDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "detail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ElectronicDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_id_key" ON "User"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_tenantId_idx" ON "Session"("tenantId");

-- CreateIndex
CREATE INDEX "LoginAttempt_key_createdAt_idx" ON "LoginAttempt"("key", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "TenantBackup_tenantId_idx" ON "TenantBackup"("tenantId");

-- CreateIndex
CREATE INDEX "AiUsage_tenantId_createdAt_idx" ON "AiUsage"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_tenantId_id_key" ON "Branch"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_tenantId_code_key" ON "Branch"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Category_tenantId_id_key" ON "Category"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_tenantId_name_key" ON "Category"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Product_tenantId_categoryId_idx" ON "Product"("tenantId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_id_key" ON "Product"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Variant_tenantId_productId_idx" ON "Variant"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_tenantId_id_key" ON "Variant"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_tenantId_sku_key" ON "Variant"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_tenantId_barcode_key" ON "Variant"("tenantId", "barcode");

-- CreateIndex
CREATE INDEX "PriceHistory_tenantId_variantId_createdAt_idx" ON "PriceHistory"("tenantId", "variantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_tenantId_id_key" ON "Lot"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_tenantId_variantId_code_key" ON "Lot"("tenantId", "variantId", "code");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_branchId_variantId_occurredAt_idx" ON "StockMovement"("tenantId", "branchId", "variantId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_occurredAt_idx" ON "StockMovement"("tenantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_id_key" ON "Customer"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tenantId_deviceKey_branchId_key" ON "Device"("tenantId", "deviceKey", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tenantId_series_key" ON "Device"("tenantId", "series");

-- CreateIndex
CREATE INDEX "SyncOperation_tenantId_createdAt_idx" ON "SyncOperation"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CashSession_tenantId_branchId_openedAt_idx" ON "CashSession"("tenantId", "branchId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CashSession_tenantId_id_key" ON "CashSession"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CashMovement_tenantId_cashSessionId_idx" ON "CashMovement"("tenantId", "cashSessionId");

-- CreateIndex
CREATE INDEX "Sale_tenantId_branchId_occurredAt_idx" ON "Sale"("tenantId", "branchId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_tenantId_id_key" ON "Sale"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_tenantId_series_number_key" ON "Sale"("tenantId", "series", "number");

-- CreateIndex
CREATE INDEX "SaleItem_tenantId_saleId_idx" ON "SaleItem"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "SaleItem_tenantId_variantId_idx" ON "SaleItem"("tenantId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleItem_tenantId_id_key" ON "SaleItem"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Payment_tenantId_cashSessionId_idx" ON "Payment"("tenantId", "cashSessionId");

-- CreateIndex
CREATE INDEX "Payment_tenantId_saleId_idx" ON "Payment"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "SaleReturn_tenantId_saleId_idx" ON "SaleReturn"("tenantId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_tenantId_code_key" ON "Voucher"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Transfer_tenantId_status_idx" ON "Transfer"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_tenantId_id_key" ON "Transfer"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TransferItem_tenantId_transferId_variantId_key" ON "TransferItem"("tenantId", "transferId", "variantId");

-- CreateIndex
CREATE INDEX "Adjustment_tenantId_status_idx" ON "Adjustment"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Adjustment_tenantId_id_key" ON "Adjustment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseDocument_tenantId_supplierRuc_docType_series_number_key" ON "PurchaseDocument"("tenantId", "supplierRuc", "docType", "series", "number");

-- CreateIndex
CREATE INDEX "SupervisorNotice_tenantId_resolvedAt_idx" ON "SupervisorNotice"("tenantId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ElectronicDocument_tenantId_saleId_key" ON "ElectronicDocument"("tenantId", "saleId");

-- AddForeignKey
ALTER TABLE "UserBranch" ADD CONSTRAINT "UserBranch_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "Category"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "Sale"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "Sale"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferItem" ADD CONSTRAINT "TransferItem_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "Transfer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

