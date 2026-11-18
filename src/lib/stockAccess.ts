// What the stock screens give a person (plan: access and roles, Task 19; DESIGN 6.2, ticks S1 to S7 and P1). Each button, field and column of the Inventory, Add Design, Edit Stock and
// Design detail screens follows the tick of the API call it makes or of the data it shows, so a person never meets a control that the API would refuse.
//
// The day-one rule rules over the tick of the call. The three roles of today get exactly the controls they got when the screens tested the role key: the Owner every control below; Staff
// the status step and the add-category rows (which were everyone's who could open Add Design and Edit Stock); the Biller none (it cannot open those two screens, and the Inventory screen
// gave it no owner control). tests/unit/stock-access.test.ts types that table in.
//
// Plain functions with no state, so they run in plain Node. The screens call them with a `Holder`, or null for a person who is not known (nobody gets a control).
import { can, canAccessPath, type Holder } from '@/lib/access';

/** Which controls of the stock screens a person gets. */
export interface StockAccess {
  /** Inventory: the Scan link. It opens Scan Detail, so it follows the gate of that screen (`secret_weight`, SCREENS of src/lib/access.ts) and never offers what the screen would refuse. */
  scanLink: boolean;
  /**
   * The original (secret) weight: the column of the inventory export, the button and the column on Design detail, the field of Add Design (and the weight its call sends) and the field of
   * Edit Stock. It is read from `sku_private` and written with `edit:sku_private.update`, which is `secret_weight`.
   */
  originalWeight: boolean;
  /**
   * Inventory: the Delete buttons of the grid, the table and the bulk bar. Nothing is deleted on the API (S7): they work on the sample data of a preview build only, and the screen has had
   * them for the Owner alone. A removal would take the design (`stock_edit`), its pieces out of stock (`stock_status`) and its photos (`photo_rewrite`), so it asks all three: of today's
   * roles Staff hold the first two and have no Delete, and the last one is what only the Owner holds.
   */
  deleteDesign: boolean;
  /** Edit Stock: the metal, the purity and the selling method of a design, the owner fields of `edit:designs.update` (`design_material`). */
  designMaterial: boolean;
  /** Edit Stock: the status of a piece and the Archive button, `fn:set_sku_status` (`stock_status`). */
  changeStatus: boolean;
  /** Add Design: the rows that add a category or a sub-category, `edit:categories.insert` and `edit:subcategories.insert` (`category_add`). */
  addCategory: boolean;
}

export function stockAccess(who: Holder | null): StockAccess {
  return {
    scanLink: canAccessPath(who, '/scan-detail'),
    originalWeight: can(who, 'secret_weight'),
    deleteDesign: can(who, 'stock_edit') && can(who, 'stock_status') && can(who, 'photo_rewrite'),
    designMaterial: can(who, 'design_material'),
    changeStatus: can(who, 'stock_status'),
    addCategory: can(who, 'category_add'),
  };
}
