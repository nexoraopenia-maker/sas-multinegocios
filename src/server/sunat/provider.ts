/**
 * Punto de extensión para la facturación electrónica (fase posterior).
 * Una implementación deberá: generar el XML UBL 2.1, firmarlo con el certificado del negocio
 * (descifrado con decryptSecret), enviarlo a SUNAT u OSE y actualizar ElectronicDocument.
 * Las ventas de cuentas con SUNAT activado ya quedan en cola (status QUEUED).
 */
export interface InvoiceRequest { tenantId: string; saleId: string; docType: '01' | '03' }
export interface InvoiceResult { status: 'SENT' | 'ACCEPTED' | 'REJECTED'; detail: string }
export interface InvoiceProvider { send(request: InvoiceRequest): Promise<InvoiceResult> }

export const invoiceProvider: InvoiceProvider = {
  async send() {
    throw new Error('La emisión electrónica SUNAT todavía no está implementada');
  },
};
