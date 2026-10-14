'use client';
import React, { useState } from 'react';
import { Download, FileText, FileSpreadsheet } from 'lucide-react';
import ReportInventory from './ReportInventory';
import ReportSales from './ReportSales';
import ReportPayments from './ReportPayments';
import ReportJewelleryMetrics from './ReportJewelleryMetrics';
import { getDesigns } from '@/lib/designStore';
import { computeAgeingStock, computeCategorySalesData, computeCategoryStockData, computeMonthlySalesData, computePaymentModeData, computePendingPayments, getInvoices } from '@/lib/appStore';
import { downloadCsv, downloadExcel, printPdf, type ExportRow } from '@/lib/exportUtils';

const REPORT_TABS = [
  { id: 'rtab-inventory', label: 'Inventory' },
  { id: 'rtab-sales', label: 'Sales' },
  { id: 'rtab-payments', label: 'Payments' },
  { id: 'rtab-jewellery', label: 'Jewellery Metrics' },
];

export default function ReportsClient() {
  const [activeTab, setActiveTab] = useState('rtab-inventory');
  const [dateFrom, setDateFrom] = useState('2026-08-01');
  const [dateTo, setDateTo] = useState('2026-08-22');

  const inDateRange = (date: string) => {
    const day = date.slice(0, 10);
    return (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo);
  };

  const reportName = REPORT_TABS.find((tab) => tab.id === activeTab)?.label ?? 'Report';

  const inventoryRows = (): ExportRow[] => {
    const categoryRows = computeCategoryStockData().map((row) => ({
      Report: 'Stock by Category',
      Name: row.name,
      Count: row.value,
      Value: '',
      Material: '',
      Status: '',
      Details: '',
    }));
    const ageingRows = computeAgeingStock().map((row) => ({
      Report: 'Ageing 90+ Days',
      Name: row.designNumber,
      Count: 1,
      Value: row.grossWeight,
      Material: row.material,
      Status: 'In Stock',
      Details: `${row.skuNumber} · ${row.category} · ${row.days} days`,
    }));
    const designRows = getDesigns().map((design) => ({
      Report: 'Design Stock Summary',
      Name: design.designNumber,
      Count: design.skus.length,
      Value: design.skus.reduce((total, sku) => total + sku.grossWeight, 0).toFixed(3),
      Material: design.material,
      Status: `${design.skus.filter((sku) => sku.status === 'In Stock').length} in stock`,
      Details: `${design.designName} · ${design.category} · ${design.purity}`,
    }));
    return [...categoryRows, ...ageingRows, ...designRows];
  };

  const salesRows = (): ExportRow[] => {
    const invoiceRows = getInvoices()
      .filter((invoice) => inDateRange(invoice.date))
      .flatMap((invoice) =>
        invoice.items.map((item) => ({
          Date: new Date(invoice.date).toLocaleDateString('en-IN'),
          'Estimate No.': invoice.invoiceNumber,
          Customer: invoice.customerName,
          Mobile: invoice.customerMobile,
          'Sale Type': invoice.saleType ?? 'Retail',
          Design: item.designNumber,
          SKU: item.skuNumber,
          Category: item.category,
          Material: item.material,
          Purity: item.purity,
          'NW (g)': item.customerNetWeight,
          Rate: item.metalRate,
          'Metal Amount': item.metalAmount,
          Labour: item.labour,
          Piroi: item.piroi,
          Total: item.itemTotal,
          Status: invoice.status,
        }))
      );
    const categoryRows = computeCategorySalesData().map((row) => ({
      Date: '',
      'Estimate No.': 'Category Summary',
      Customer: row.category,
      Mobile: '',
      'Sale Type': '',
      Design: '',
      SKU: '',
      Category: row.category,
      Material: '',
      Purity: '',
      'NW (g)': '',
      Rate: '',
      'Metal Amount': '',
      Labour: '',
      Piroi: '',
      Total: row.value,
      Status: `${row.count} units`,
    }));
    return [...invoiceRows, ...categoryRows];
  };

  const paymentRows = (): ExportRow[] => {
    const invoicePaymentRows = getInvoices()
      .filter((invoice) => inDateRange(invoice.date))
      .flatMap((invoice) =>
        invoice.payments.map((payment) => ({
          Date: new Date(payment.date).toLocaleDateString('en-IN'),
          Customer: invoice.customerName,
          Mobile: invoice.customerMobile,
          'Estimate No.': invoice.invoiceNumber,
          Mode: payment.mode,
          Amount: payment.amount,
          Reference: payment.reference,
          Notes: payment.notes,
          Status: invoice.status,
        }))
      );
    const modeRows = computePaymentModeData().map((row) => ({
      Date: '',
      Customer: 'Payment Mode Summary',
      Mobile: '',
      'Estimate No.': '',
      Mode: row.mode,
      Amount: row.amount,
      Reference: `${row.value}%`,
      Notes: '',
      Status: '',
    }));
    const pendingRows = computePendingPayments().map((row) => ({
      Date: '',
      Customer: row.customerName,
      Mobile: row.mobile,
      'Estimate No.': row.invoiceNumber,
      Mode: 'Pending',
      Amount: row.amount,
      Reference: '',
      Notes: `${row.daysOld} days pending`,
      Status: 'Pending',
    }));
    return [...invoicePaymentRows, ...modeRows, ...pendingRows];
  };

  const jewelleryRows = (): ExportRow[] =>
    getInvoices()
      .filter((invoice) => inDateRange(invoice.date))
      .flatMap((invoice) =>
        invoice.items.map((item) => ({
          Date: new Date(invoice.date).toLocaleDateString('en-IN'),
          'Estimate No.': invoice.invoiceNumber,
          SKU: item.skuNumber,
          Material: item.material,
          Purity: item.purity,
          'Gross Weight (g)': item.grossWeight,
          'Customer NW (g)': item.customerNetWeight,
          Rate: item.metalRate,
          'Metal Amount': item.metalAmount,
          Labour: item.labour,
          Piroi: item.piroi,
          'Other Charges': item.otherCharges,
          'Item Total': item.itemTotal,
          'Silver Fine Due (g)': item.fineWeightDue ?? 0,
        }))
      );

  const getRowsForActiveReport = () => {
    if (activeTab === 'rtab-sales') return salesRows();
    if (activeTab === 'rtab-payments') return paymentRows();
    if (activeTab === 'rtab-jewellery') return jewelleryRows();
    return inventoryRows();
  };

  const exportReport = (format: 'excel' | 'csv' | 'pdf') => {
    const rows = getRowsForActiveReport();
    const title = `${reportName} Report`;
    const subtitle = activeTab === 'rtab-inventory' ? 'Current inventory' : `${dateFrom || 'Start'} to ${dateTo || 'Today'}`;
    if (format === 'excel') downloadExcel(title, rows, subtitle);
    if (format === 'csv') downloadCsv(title, rows);
    if (format === 'pdf') printPdf(title, rows, subtitle);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Reports</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Business analytics and data exports</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2">
            <span className="text-xs text-muted-foreground">From</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e?.target?.value)}
              className="text-xs font-semibold text-foreground bg-transparent outline-none"
            />
            <span className="text-xs text-muted-foreground">To</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e?.target?.value)}
              className="text-xs font-semibold text-foreground bg-transparent outline-none"
            />
          </div>
          <button onClick={() => exportReport('excel')} className="btn-secondary py-2 text-xs">
            <FileSpreadsheet size={14} /> Excel
          </button>
          <button onClick={() => exportReport('csv')} className="btn-secondary py-2 text-xs">
            <Download size={14} /> CSV
          </button>
          <button onClick={() => exportReport('pdf')} className="btn-ghost py-2 text-xs">
            <FileText size={14} /> PDF
          </button>
        </div>
      </div>
      {/* Tab Bar */}
      <div className="jewel-card overflow-hidden">
        <div className="flex border-b border-border px-4 bg-muted/20 overflow-x-auto scrollbar-thin">
          {REPORT_TABS?.map((tab) => (
            <button
              key={tab?.id}
              onClick={() => setActiveTab(tab?.id)}
              className={`px-4 py-3 text-sm transition-colors whitespace-nowrap ${
                activeTab === tab?.id ? 'tab-active' : 'tab-inactive'
              }`}
            >
              {tab?.label}
            </button>
          ))}
        </div>

        <div className="p-5">
          {activeTab === 'rtab-inventory' && <ReportInventory />}
          {activeTab === 'rtab-sales' && <ReportSales />}
          {activeTab === 'rtab-payments' && <ReportPayments />}
          {activeTab === 'rtab-jewellery' && <ReportJewelleryMetrics />}
        </div>
      </div>
    </div>
  );
}
