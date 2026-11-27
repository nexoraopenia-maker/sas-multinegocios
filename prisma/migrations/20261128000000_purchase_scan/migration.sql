-- Respaldo de comprobantes escaneados: archivo original, borrador extraído por la IA y su enlace con el ingreso.
CREATE TABLE "PurchaseScan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "model" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "operationId" TEXT,
    "purchaseDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "PurchaseScan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseScan_tenantId_sha256_key" ON "PurchaseScan"("tenantId", "sha256");
CREATE INDEX "PurchaseScan_tenantId_createdAt_idx" ON "PurchaseScan"("tenantId", "createdAt");

ALTER TABLE "PurchaseScan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseScan" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PurchaseScan" USING ("tenantId" = app_tenant()) WITH CHECK ("tenantId" = app_tenant());
-- El archivo de respaldo es inmutable para la aplicación: solo puede marcarse como registrado.
GRANT SELECT, INSERT ON "PurchaseScan" TO saas_app;
GRANT UPDATE ("branchId", "status", "operationId", "purchaseDocumentId", "confirmedAt") ON "PurchaseScan" TO saas_app;

-- Para revertir (se pierden los respaldos): DROP TABLE "PurchaseScan";
