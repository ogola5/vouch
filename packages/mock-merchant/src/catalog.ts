import { toMinorUnits, type UcpAmount } from "@vouch/shared";

/**
 * The demo catalog, and the price-drop control surface the build plan calls
 * for in week 2 ("a panel in web-app or a CLI script that lets you trigger
 * 'price of Brand A detergent drops to $12.49'").
 *
 * Keeping the mutable price here, on the merchant, rather than in the
 * orchestrator is what makes demo steps 2 and 3 of the brief's script live
 * rather than narrated: the agent observes a price it did not choose, and
 * the gate decides on a number the merchant reported.
 *
 * PRICES ARE IN ISO 4217 MINOR UNITS, like everything else crossing the UCP
 * boundary. The catalog is authored with toMinorUnits() so the dollar figures
 * stay readable in source.
 */

export interface CatalogProduct {
  id: string;
  title: string;
  brand: string;
  price: UcpAmount;
  currency: string;
}

/**
 * Seeded from the brief's demo script: Brand A is the mandate's preferred
 * brand, Brand B its fallback, and Brand C is the $27.80 item that must be
 * stopped by the gate in step 3.
 */
function seedProducts(): CatalogProduct[] {
  return [
    {
      id: "detergent-brand-a",
      title: "Brand A Laundry Detergent, 64 loads",
      brand: "Brand A",
      price: toMinorUnits(14.99, "USD"),
      currency: "USD",
    },
    {
      id: "detergent-brand-b",
      title: "Brand B Laundry Detergent, 60 loads",
      brand: "Brand B",
      price: toMinorUnits(13.49, "USD"),
      currency: "USD",
    },
    {
      id: "detergent-brand-c",
      title: "Brand C Laundry Detergent, 96 loads",
      brand: "Brand C",
      price: toMinorUnits(27.8, "USD"),
      currency: "USD",
    },
  ];
}

export class Catalog {
  private products = new Map<string, CatalogProduct>();

  constructor(products: CatalogProduct[] = seedProducts()) {
    for (const product of products) {
      this.products.set(product.id, { ...product });
    }
  }

  get(id: string): CatalogProduct | undefined {
    const product = this.products.get(id);
    return product ? { ...product } : undefined;
  }

  list(): CatalogProduct[] {
    return [...this.products.values()].map((p) => ({ ...p }));
  }

  /**
   * The demo-control lever. Takes MAJOR units because a human operating the
   * demo panel types "12.49", not "1249" — the conversion happens here, at
   * the one place a human-authored price enters the system.
   */
  setPriceMajor(id: string, priceMajor: number): CatalogProduct {
    const product = this.products.get(id);
    if (!product) {
      throw new Error(`No catalog product with id "${id}"`);
    }
    product.price = toMinorUnits(priceMajor, product.currency);
    return { ...product };
  }
}
