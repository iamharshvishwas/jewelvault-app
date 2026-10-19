// The rows of the inventory screen's CSV, Excel and print exports (spec D9, D12, A14; test T-D03; task WEB12b). The screen is open to all three roles, so what the rows hold depends on the role:
// the owner-only original weight of a piece is a column for the owner and does not exist for anybody else. (A biller's or staff user's cache has no such weight to give, and the column of zeros
// that the export used to carry for them read as "a weight of nothing", which is a false statement about the stock.)
import type { AuthRole } from '@/lib/authStore';
import type { ExportRow } from '@/lib/exportUtils';
import type { Design } from '@/lib/mockData';

export const ORIGINAL_WEIGHT_COLUMN = 'Original Net Weight (g)';

export function inventoryExportRows(
  designs: readonly Design[],
  role: AuthRole | null
): ExportRow[] {
  return designs.flatMap((design) =>
    design.skus.map((sku) => ({
      'Design No.': design.designNumber,
      'Design Name': design.designName,
      Category: design.category,
      Subcategory: design.subcategory,
      SKU: sku.skuNumber,
      Barcode: sku.barcode,
      Material: sku.material,
      Purity: sku.purity,
      'Selling Method': sku.sellingMethod,
      Status: sku.status,
      Location: sku.location,
      'Gross Weight (g)': sku.grossWeight,
      ...(role === 'owner' ? { [ORIGINAL_WEIGHT_COLUMN]: sku.originalNetWeight } : {}),
      'Customer Net Weight (g)': sku.customerNetWeight,
      Stones: sku.stones,
      'Stone Weight': sku.stoneWeight,
      Kundan: sku.kundan,
      'Kundan Weight': sku.kundanWeight,
      Piroi: sku.piroi,
      'Retail Labour/Rate': sku.retailLabour ?? sku.labour,
      'Semi-Wholesale Labour/Rate': sku.semiWholesaleLabour ?? '',
      'Wholesale Labour/Rate': sku.wholesaleLabour ?? sku.labour,
      'Created At': new Date(sku.createdAt).toLocaleString('en-IN'),
      Notes: sku.notes,
    }))
  );
}
