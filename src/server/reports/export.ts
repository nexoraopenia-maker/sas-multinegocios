import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Report } from '@/shared/reports';

/** Evita que un texto se interprete como fórmula al abrir el archivo en una hoja de cálculo. */
const safe = (v: string | number | undefined) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v ?? '');

export async function toXlsx(report: Report) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(report.title.slice(0, 31));
  sheet.addRow([report.title]).font = { bold: true, size: 14 };
  sheet.addRow([report.subtitle]);
  sheet.addRow([]);
  sheet.addRow(report.columns.map((c) => c.label)).font = { bold: true };
  for (const row of report.rows) sheet.addRow(report.columns.map((c) => safe(row[c.key])));
  if (report.totals) sheet.addRow(report.columns.map((c, i) => (i === 0 ? 'Total' : report.totals![c.key] ?? ''))).font = { bold: true };
  report.columns.forEach((c, i) => {
    const col = sheet.getColumn(i + 1);
    col.width = Math.max(14, c.label.length + 4);
    if (c.kind === 'money') col.numFmt = '#,##0.00';
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function toPdf(report: Report) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 842, H = 595, M = 32, LINE = 14, SIZE = 8;
  const weights = report.columns.map((c) => (c.kind === 'money' || c.kind === 'number' ? 1 : 1.8));
  const unit = (W - M * 2) / (weights.reduce((s, w) => s + w, 0) || 1);
  // Las fuentes estándar solo admiten WinAnsi.
  const clean = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
  const fit = (s: string, width: number) => {
    let t = clean(s);
    while (t.length > 1 && font.widthOfTextAtSize(t, SIZE) > width - 4) t = t.slice(0, -2) + '.';
    return t;
  };
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const line = (cells: string[], f = font) => {
    let x = M;
    cells.forEach((cell, i) => {
      const width = unit * weights[i];
      const text = fit(cell, width);
      const right = ['money', 'number'].includes(report.columns[i].kind ?? '');
      page.drawText(text, { x: right ? x + width - 4 - f.widthOfTextAtSize(text, SIZE) : x, y, size: SIZE, font: f });
      x += width;
    });
    y -= LINE;
  };
  const header = () => {
    line(report.columns.map((c) => c.label), bold);
    page.drawLine({ start: { x: M, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
    y -= 2;
  };
  page.drawText(clean(report.title), { x: M, y, size: 14, font: bold });
  y -= 18;
  page.drawText(clean(report.subtitle), { x: M, y, size: 9, font });
  y -= 22;
  header();
  const format = (v: string | number | undefined, kind?: string) => (kind === 'money' && typeof v === 'number' ? v.toFixed(2) : String(v ?? ''));
  for (const row of report.rows) {
    if (y < M) { page = pdf.addPage([W, H]); y = H - M; header(); }
    line(report.columns.map((c) => format(row[c.key], c.kind)));
  }
  if (report.totals) {
    if (y < M) { page = pdf.addPage([W, H]); y = H - M; header(); }
    line(report.columns.map((c, i) => (i === 0 ? 'Total' : format(report.totals![c.key], c.kind))), bold);
  }
  return Buffer.from(await pdf.save());
}
