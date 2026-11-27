-- Aislamiento multi-tenant en la base de datos.
-- La aplicación se conecta como "saas_app" (sin BYPASSRLS) y fija en cada transacción:
--   app.tenant_id  → negocio de la sesión
--   app.platform   → 'on' solo para autenticación y SuperAdmin

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saas_app') THEN
    CREATE ROLE saas_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- Precios iniciales de modelos de IA (USD por millón de tokens), editables desde el SuperAdmin.
INSERT INTO "AiModelPrice" ("model","inputPerMTok","outputPerMTok","updatedAt") VALUES
  ('claude-opus-5-5', 4, 20, now()),
  ('claude-opus-4-8', 5, 25, now()),
  ('claude-sonnet-5-5', 2, 10, now()),
  ('claude-sonnet-5', 2, 10, now()),
  ('claude-haiku-5-5', 0.1, 0.5, now());

CREATE FUNCTION app_tenant() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;

CREATE FUNCTION app_platform() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.platform', true), '') = 'on' $$;

GRANT USAGE ON SCHEMA public TO saas_app;

-- Tablas de negocio: aislamiento estricto por tenant, sin excepción de plataforma.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'TenantSettings','Counter','Branch','UserBranch','Category','Product','Variant','PriceHistory','Lot',
    'StockMovement','StockBalance','Customer','Device','SyncOperation','CashSession','CashMovement',
    'Sale','SaleItem','Payment','SaleReturn','Voucher','Transfer','TransferItem','Adjustment',
    'PurchaseDocument','SupervisorNotice','SunatConfig','ElectronicDocument'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_tenant()) WITH CHECK ("tenantId" = app_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO saas_app', t);
  END LOOP;
END $$;

-- El SuperAdmin crea el negocio inicial (sucursal, ajustes, categorías) dentro del contexto del tenant,
-- por lo que no necesita políticas adicionales sobre las tablas de negocio.

-- El kárdex y la idempotencia son de solo inserción.
REVOKE UPDATE, DELETE ON "StockMovement" FROM saas_app;
REVOKE UPDATE, DELETE ON "SyncOperation" FROM saas_app;
REVOKE UPDATE, DELETE ON "PriceHistory" FROM saas_app;

-- Tenant: cada negocio puede leerse; solo la plataforma escribe (feature flags, estado, límites).
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON "Tenant" FOR SELECT USING (app_platform() OR "id" = app_tenant());
CREATE POLICY tenant_platform ON "Tenant" USING (app_platform()) WITH CHECK (app_platform());
GRANT SELECT, INSERT, UPDATE ON "Tenant" TO saas_app;

-- Usuarios: un negocio nunca puede ver ni crear usuarios de plataforma o de otros negocios.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_platform ON "User" USING (app_platform()) WITH CHECK (app_platform());
CREATE POLICY user_tenant ON "User"
  USING ("tenantId" = app_tenant() AND "role" <> 'SUPERADMIN')
  WITH CHECK ("tenantId" = app_tenant() AND "role" <> 'SUPERADMIN');
GRANT SELECT, INSERT, UPDATE ON "User" TO saas_app;

ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Session" FORCE ROW LEVEL SECURITY;
CREATE POLICY session_access ON "Session"
  USING (app_platform() OR "tenantId" = app_tenant())
  WITH CHECK (app_platform() OR "tenantId" = app_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON "Session" TO saas_app;

ALTER TABLE "LoginAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoginAttempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON "LoginAttempt" USING (app_platform()) WITH CHECK (app_platform());
GRANT SELECT, INSERT, DELETE ON "LoginAttempt" TO saas_app;

ALTER TABLE "TenantBackup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantBackup" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON "TenantBackup" USING (app_platform()) WITH CHECK (app_platform());
GRANT SELECT, INSERT ON "TenantBackup" TO saas_app;

-- Auditoría: solo inserción y lectura.
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON "AuditLog" FOR SELECT USING (app_platform() OR "tenantId" = app_tenant());
CREATE POLICY audit_insert ON "AuditLog" FOR INSERT WITH CHECK (app_platform() OR "tenantId" = app_tenant());
GRANT SELECT, INSERT ON "AuditLog" TO saas_app;

ALTER TABLE "AiModelPrice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiModelPrice" FORCE ROW LEVEL SECURITY;
CREATE POLICY price_read ON "AiModelPrice" FOR SELECT USING (true);
CREATE POLICY price_platform ON "AiModelPrice" USING (app_platform()) WITH CHECK (app_platform());
GRANT SELECT, INSERT, UPDATE, DELETE ON "AiModelPrice" TO saas_app;

ALTER TABLE "AiUsage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiUsage" FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_access ON "AiUsage"
  USING (app_platform() OR "tenantId" = app_tenant())
  WITH CHECK (app_platform() OR "tenantId" = app_tenant());
GRANT SELECT, INSERT, UPDATE ON "AiUsage" TO saas_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO saas_app;

-- Saldo de stock derivado del kárdex.
CREATE FUNCTION apply_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "StockBalance" ("tenantId","branchId","variantId","lotKey","quantity")
  VALUES (NEW."tenantId", NEW."branchId", NEW."variantId", coalesce(NEW."lotId", ''), NEW."quantity")
  ON CONFLICT ("tenantId","branchId","variantId","lotKey")
  DO UPDATE SET "quantity" = "StockBalance"."quantity" + EXCLUDED."quantity";
  RETURN NEW;
END $$;

CREATE TRIGGER stock_movement_balance AFTER INSERT ON "StockMovement"
FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();
