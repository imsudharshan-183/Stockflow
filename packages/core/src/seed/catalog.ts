import type { Branch } from "../schemas/index.js";

export interface CategoryItemSpec {
  name: string;
  variants: readonly [string, string, string, string, string, string];
}

export interface CategorySpec {
  name: string;
  basePrice: number;
  leadTimeDays: number;
  meanDemand: number;
  brands: readonly [string, string, string, string];
  items: readonly CategoryItemSpec[];
  nouns: readonly string[];
}

interface RawCategorySpec {
  name: string;
  basePrice: number;
  leadTimeDays: number;
  meanDemand: number;
  brands: readonly [string, string, string, string];
  items: readonly CategoryItemSpec[];
}

const RAW_CATEGORIES: readonly RawCategorySpec[] = [
  {
    name: "Beverages",
    basePrice: 4,
    leadTimeDays: 4,
    meanDemand: 5,
    brands: ["Aurelia", "Clearwater", "Sunridge", "Northfield"],
    items: [
      { name: "Sparkling Water", variants: ["330 ml", "500 ml", "750 ml", "1 L", "Pack of 6", "Pack of 12"] },
      { name: "Cold Brew Coffee", variants: ["250 ml", "330 ml", "500 ml", "750 ml", "1 L", "Pack of 4"] },
      { name: "Lemon Verbena Soda", variants: ["250 ml", "330 ml", "500 ml", "750 ml", "Pack of 4", "Pack of 6"] },
      { name: "Brewed Iced Tea", variants: ["330 ml", "500 ml", "750 ml", "1 L", "1.5 L", "Pack of 6"] },
      { name: "Alpine Spring Water", variants: ["330 ml", "500 ml", "750 ml", "1 L", "1.5 L", "Pack of 12"] },
      { name: "Pressed Orange Juice", variants: ["250 ml", "330 ml", "500 ml", "750 ml", "1 L", "1.5 L"] },
      { name: "Ginger Root Beer", variants: ["250 ml", "330 ml", "500 ml", "750 ml", "Pack of 4", "Pack of 6"] },
      { name: "Blood Orange Spritz", variants: ["250 ml", "330 ml", "500 ml", "750 ml", "Pack of 4", "Pack of 6"] },
    ],
  },
  {
    name: "Snacks",
    basePrice: 3.5,
    leadTimeDays: 4,
    meanDemand: 4.2,
    brands: ["Harvest Mill", "Northfield", "Sunridge", "Meadowbrook"],
    items: [
      { name: "Sea Salt Potato Chips", variants: ["85 g", "140 g", "200 g", "280 g", "400 g", "Pack of 6"] },
      { name: "Orchard Trail Mix", variants: ["100 g", "170 g", "250 g", "340 g", "500 g", "750 g"] },
      { name: "Sourdough Pretzel Sticks", variants: ["120 g", "200 g", "280 g", "400 g", "500 g", "Pack of 6"] },
      { name: "Oat & Honey Granola Bar", variants: ["40 g", "60 g", "Pack of 4", "Pack of 6", "Pack of 8", "Pack of 12"] },
      { name: "Aged Cheddar Crackers", variants: ["110 g", "180 g", "250 g", "340 g", "450 g", "Pack of 6"] },
      { name: "Sea Salt Kettle Popcorn", variants: ["70 g", "120 g", "180 g", "250 g", "340 g", "Pack of 6"] },
      { name: "Roasted Salted Almonds", variants: ["100 g", "170 g", "250 g", "340 g", "500 g", "750 g"] },
      { name: "Dark Chocolate Pretzel Bark", variants: ["90 g", "150 g", "225 g", "300 g", "400 g", "500 g"] },
    ],
  },
  {
    name: "Dairy",
    basePrice: 5,
    leadTimeDays: 2,
    meanDemand: 3.8,
    brands: ["Meadowbrook", "Cloverdale", "Northfield", "Aldervale"],
    items: [
      { name: "Organic Whole Milk", variants: ["500 ml", "750 ml", "1 L", "1.5 L", "2 L", "Pack of 2"] },
      { name: "Strained Greek Yogurt", variants: ["150 g", "250 g", "450 g", "680 g", "900 g", "Pack of 4"] },
      { name: "Sharp Cheddar Cheese", variants: ["170 g", "225 g", "340 g", "450 g", "680 g", "900 g"] },
      { name: "Cultured Sweet Butter", variants: ["115 g", "225 g", "340 g", "450 g", "680 g", "900 g"] },
      { name: "Small Curd Cottage Cheese", variants: ["225 g", "340 g", "450 g", "680 g", "900 g", "1 kg"] },
      { name: "Heavy Whipping Cream", variants: ["250 ml", "350 ml", "500 ml", "750 ml", "1 L", "1.5 L"] },
      { name: "Aged Gouda Cheese", variants: ["150 g", "200 g", "280 g", "350 g", "450 g", "600 g"] },
      { name: "Salted Farmhouse Butter", variants: ["115 g", "200 g", "250 g", "340 g", "450 g", "680 g"] },
    ],
  },
  {
    name: "Household",
    basePrice: 8,
    leadTimeDays: 6,
    meanDemand: 2,
    brands: ["Northfield", "Clearwater", "Harbor & Pine", "Crestwood"],
    items: [
      { name: "Liquid Dish Soap", variants: ["350 ml", "500 ml", "750 ml", "1 L", "1.5 L", "Pack of 2"] },
      { name: "Laundry Detergent", variants: ["750 ml", "1 L", "1.5 L", "2 L", "3 L", "Pack of 2"] },
      { name: "Absorbent Paper Towels", variants: ["Pack of 2", "Pack of 4", "Pack of 6", "Pack of 8", "Pack of 12", "Pack of 16"] },
      { name: "Drawstring Trash Bags", variants: ["15 pcs", "20 pcs", "30 pcs", "40 pcs", "50 pcs", "80 pcs"] },
      { name: "Citrus All-Purpose Cleaner", variants: ["350 ml", "500 ml", "750 ml", "1 L", "1.5 L", "Pack of 2"] },
      { name: "Cellulose Scrub Sponges", variants: ["Pack of 2", "Pack of 3", "Pack of 4", "Pack of 6", "Pack of 8", "Pack of 12"] },
      { name: "Dishwasher Detergent Pods", variants: ["16 pcs", "24 pcs", "32 pcs", "48 pcs", "60 pcs", "72 pcs"] },
      { name: "Microfiber Cleaning Cloths", variants: ["Pack of 3", "Pack of 4", "Pack of 6", "Pack of 8", "Pack of 10", "Pack of 12"] },
    ],
  },
  {
    name: "Personal Care",
    basePrice: 7,
    leadTimeDays: 7,
    meanDemand: 1.6,
    brands: ["Aurelia", "Solstice", "Veritas", "Clearwater"],
    items: [
      { name: "Botanical Shampoo", variants: ["200 ml", "300 ml", "400 ml", "500 ml", "750 ml", "1 L"] },
      { name: "Shea Moisture Bar Soap", variants: ["100 g", "150 g", "200 g", "Pack of 2", "Pack of 3", "Pack of 6"] },
      { name: "Mint Whitening Toothpaste", variants: ["75 ml", "100 ml", "125 ml", "150 ml", "Pack of 2", "Pack of 3"] },
      { name: "Oat Daily Body Lotion", variants: ["150 ml", "250 ml", "350 ml", "500 ml", "750 ml", "1 L"] },
      { name: "Gentle Foaming Face Wash", variants: ["100 ml", "150 ml", "200 ml", "250 ml", "300 ml", "400 ml"] },
      { name: "Mineral Roll-On Deodorant", variants: ["50 ml", "75 ml", "85 g", "100 g", "Pack of 2", "Pack of 3"] },
      { name: "Argan Repair Conditioner", variants: ["200 ml", "300 ml", "400 ml", "500 ml", "750 ml", "1 L"] },
      { name: "Aloe Hydrating Hand Wash", variants: ["250 ml", "300 ml", "400 ml", "500 ml", "750 ml", "1 L"] },
    ],
  },
  {
    name: "Stationery",
    basePrice: 4.5,
    leadTimeDays: 8,
    meanDemand: 1.2,
    brands: ["Veritas", "Kestrel", "Alder & Co", "Crestwood"],
    items: [
      { name: "Ruled Hardcover Notebook", variants: ["80 Sheets", "120 Sheets", "160 Sheets", "200 Sheets", "240 Sheets", "Pack of 2"] },
      { name: "Gel Ballpoint Pens", variants: ["Pack of 4", "Pack of 6", "Pack of 8", "Pack of 10", "Pack of 12", "Pack of 24"] },
      { name: "Pastel Sticky Notes", variants: ["100 Sheets", "200 Sheets", "300 Sheets", "400 Sheets", "Pack of 4", "Pack of 8"] },
      { name: "Archival Ring Binder", variants: ["1 in", "1.5 in", "2 in", "3 in", "Pack of 2", "Pack of 4"] },
      { name: "Graphite Drafting Pencils", variants: ["Pack of 6", "Pack of 10", "Pack of 12", "Pack of 18", "Pack of 24", "Pack of 36"] },
      { name: "Heavyweight Index Cards", variants: ["50 pcs", "100 pcs", "150 pcs", "200 pcs", "300 pcs", "500 pcs"] },
      { name: "Fine Tip Highlighters", variants: ["Pack of 4", "Pack of 6", "Pack of 8", "Pack of 10", "Pack of 12", "Pack of 16"] },
      { name: "Kraft File Folders", variants: ["Pack of 6", "Pack of 12", "Pack of 18", "Pack of 24", "Pack of 36", "Pack of 50"] },
    ],
  },
  {
    name: "Toys",
    basePrice: 18,
    leadTimeDays: 10,
    meanDemand: 0.7,
    brands: ["Bluepeak", "Northfield", "Crestwood", "Sunridge"],
    items: [
      { name: "Wooden Building Blocks", variants: ["40 pcs", "60 pcs", "80 pcs", "100 pcs", "150 pcs", "200 pcs"] },
      { name: "Illustrated Jigsaw Puzzle", variants: ["100 pcs", "250 pcs", "300 pcs", "500 pcs", "750 pcs", "1000 pcs"] },
      { name: "Plush Stuffed Bear", variants: ["8 in", "10 in", "12 in", "14 in", "16 in", "20 in"] },
      { name: "Family Strategy Board Game", variants: ["Classic Edition", "Travel Edition", "Deluxe Edition", "Junior Edition", "2 Player Set", "4 Player Set"] },
      { name: "Die-Cast Alloy Toy Car", variants: ["Single Pack", "Pack of 2", "Pack of 3", "Pack of 5", "Pack of 8", "Pack of 10"] },
      { name: "Studio Art Coloring Set", variants: ["24 pcs", "36 pcs", "48 pcs", "60 pcs", "72 pcs", "96 pcs"] },
      { name: "Magnetic Tile Builder Set", variants: ["32 pcs", "48 pcs", "64 pcs", "80 pcs", "100 pcs", "120 pcs"] },
      { name: "Wooden Train Track Set", variants: ["25 pcs", "40 pcs", "55 pcs", "70 pcs", "85 pcs", "100 pcs"] },
    ],
  },
  {
    name: "Pet Supplies",
    basePrice: 14,
    leadTimeDays: 9,
    meanDemand: 0.8,
    brands: ["Timberline", "Meadowbrook", "Bluepeak", "Northfield"],
    items: [
      { name: "Adult Dry Dog Food", variants: ["1.5 kg", "2.5 kg", "4 kg", "6 kg", "10 kg", "12 kg"] },
      { name: "Indoor Dry Cat Food", variants: ["1 kg", "2 kg", "3 kg", "4.5 kg", "6 kg", "8 kg"] },
      { name: "Salmon Training Treats", variants: ["100 g", "170 g", "250 g", "340 g", "450 g", "600 g"] },
      { name: "Unscented Clumping Cat Litter", variants: ["3 kg", "5 kg", "7 kg", "9 kg", "12 kg", "15 kg"] },
      { name: "Natural Rubber Chew Toy", variants: ["Small", "Medium", "Large", "Extra Large", "Pack of 2", "Pack of 3"] },
      { name: "Oatmeal Coat Pet Shampoo", variants: ["250 ml", "350 ml", "500 ml", "750 ml", "1 L", "Pack of 2"] },
      { name: "Freeze-Dried Beef Liver Bites", variants: ["85 g", "140 g", "200 g", "280 g", "400 g", "500 g"] },
      { name: "Woven Cotton Rope Tug Toy", variants: ["10 in", "12 in", "15 in", "18 in", "22 in", "Pack of 2"] },
    ],
  },
  {
    name: "Kitchenware",
    basePrice: 16,
    leadTimeDays: 11,
    meanDemand: 0.55,
    brands: ["Crestwood", "Alder & Co", "Harbor & Pine", "Veritas"],
    items: [
      { name: "Stainless Mixing Bowl", variants: ["1.5 qt", "2 qt", "3 qt", "4 qt", "5 qt", "Set of 3"] },
      { name: "Tri-Ply Clad Saucepan", variants: ["1.5 qt", "2 qt", "2.5 qt", "3 qt", "3.5 qt", "4 qt"] },
      { name: "Silicone Turner Spatula", variants: ["10 in", "11 in", "12 in", "14 in", "Pack of 2", "Set of 3"] },
      { name: "End-Grain Cutting Board", variants: ["12 in", "14 in", "16 in", "18 in", "20 in", "Set of 2"] },
      { name: "Stainless Measuring Cups", variants: ["Set of 4", "Set of 5", "Set of 6", "Set of 8", "Heavy Gauge", "Nesting Set"] },
      { name: "Borosilicate Storage Jar", variants: ["500 ml", "750 ml", "1 L", "1.5 L", "2 L", "Set of 3"] },
      { name: "Cast Iron Skillet", variants: ["8 in", "9 in", "10 in", "11 in", "12 in", "14 in"] },
      { name: "Stoneware Baking Dish", variants: ["8 in", "9 in", "10 in", "11 in", "13 in", "Set of 2"] },
    ],
  },
  {
    name: "Home Decor",
    basePrice: 22,
    leadTimeDays: 12,
    meanDemand: 0.4,
    brands: ["Harbor & Pine", "Solstice", "Aurelia", "Alder & Co"],
    items: [
      { name: "Linen Throw Pillow", variants: ["16 in", "18 in", "20 in", "22 in", "24 in", "Set of 2"] },
      { name: "Walnut Gallery Picture Frame", variants: ["4x6 in", "5x7 in", "8x10 in", "11x14 in", "12x16 in", "Set of 2"] },
      { name: "Ceramic Bedside Table Lamp", variants: ["14 in", "16 in", "18 in", "20 in", "22 in", "24 in"] },
      { name: "Cedar & Fig Soy Candle", variants: ["4 oz", "6 oz", "8 oz", "10 oz", "12 oz", "16 oz"] },
      { name: "Handwoven Jute Area Rug", variants: ["2x3 ft", "3x5 ft", "4x6 ft", "5x7 ft", "5x8 ft", "6x9 ft"] },
      { name: "Fluted Stoneware Vase", variants: ["6 in", "8 in", "10 in", "12 in", "14 in", "16 in"] },
      { name: "Cotton Herringbone Throw Blanket", variants: ["50x60 in", "50x70 in", "60x80 in", "Oatmeal", "Slate", "Sage"] },
      { name: "Brushed Brass Wall Mirror", variants: ["16 in", "20 in", "24 in", "28 in", "30 in", "32 in"] },
    ],
  },
  {
    name: "Health & Wellness",
    basePrice: 12,
    leadTimeDays: 8,
    meanDemand: 0.9,
    brands: ["Veritas", "Clearwater", "Solstice", "Aurelia"],
    items: [
      { name: "Buffered Vitamin C Tablets", variants: ["30 pcs", "60 pcs", "90 pcs", "120 pcs", "180 pcs", "250 pcs"] },
      { name: "Travel First Aid Kit", variants: ["45 pcs", "65 pcs", "85 pcs", "110 pcs", "150 pcs", "200 pcs"] },
      { name: "Aloe Gel Hand Sanitizer", variants: ["60 ml", "100 ml", "250 ml", "500 ml", "1 L", "Pack of 3"] },
      { name: "Fabric Adhesive Bandages", variants: ["30 pcs", "50 pcs", "75 pcs", "100 pcs", "150 pcs", "200 pcs"] },
      { name: "Menthol Cooling Relief Gel", variants: ["50 g", "75 g", "100 g", "150 g", "200 g", "Pack of 2"] },
      { name: "Digital Temple Thermometer", variants: ["Compact", "Backlit Display", "Dual Scale", "Rapid Read", "Pediatric Tip", "Travel Case"] },
      { name: "Electrolyte Hydration Packets", variants: ["Pack of 6", "Pack of 10", "Pack of 16", "Pack of 20", "Pack of 30", "Pack of 40"] },
      { name: "Melatonin Sleep Gummies", variants: ["30 pcs", "45 pcs", "60 pcs", "75 pcs", "90 pcs", "120 pcs"] },
    ],
  },
  {
    name: "Accessories",
    basePrice: 15,
    leadTimeDays: 9,
    meanDemand: 0.6,
    brands: ["Harbor & Pine", "Kestrel", "Alder & Co", "Crestwood"],
    items: [
      { name: "Heavyweight Canvas Tote", variants: ["Natural", "Navy", "Olive", "Charcoal", "Terracotta", "Black"] },
      { name: "Polarized Acetate Sunglasses", variants: ["Tortoise", "Matte Black", "Amber", "Slate Grey", "Crystal", "Havana"] },
      { name: "Twill Six-Panel Baseball Cap", variants: ["Navy", "Khaki", "Forest", "Charcoal", "Stone", "Black"] },
      { name: "Full-Grain Leather Belt", variants: ["S", "M", "L", "XL", "Tan", "Espresso"] },
      { name: "Merino Ribbed Knit Scarf", variants: ["Oatmeal", "Charcoal", "Camel", "Navy", "Heather Grey", "Burgundy"] },
      { name: "Bifold Stitched Leather Wallet", variants: ["Saddle Tan", "Espresso", "Black", "Chestnut", "Navy", "Oxblood"] },
      { name: "Waxed Canvas Dopp Kit", variants: ["Olive", "Navy", "Charcoal", "Field Tan", "Slate", "Briar"] },
      { name: "Cotton Crew Ankle Socks", variants: ["S", "M", "L", "Pack of 3", "Pack of 5", "Pack of 6"] },
    ],
  },
];

export const CATEGORIES: readonly CategorySpec[] = RAW_CATEGORIES.map((category) => ({
  ...category,
  nouns: category.items.map((item) => item.name),
}));

export const BRANCHES: readonly Branch[] = [
  { id: "BR-001", name: "Chicago - Loop", city: "Chicago", region: "Midwest" },
  { id: "BR-002", name: "Chicago - Lincoln Park", city: "Chicago", region: "Midwest" },
  { id: "BR-003", name: "New York - Midtown", city: "New York", region: "Northeast" },
  { id: "BR-004", name: "New York - Brooklyn", city: "New York", region: "Northeast" },
  { id: "BR-005", name: "Los Angeles - Santa Monica", city: "Los Angeles", region: "West" },
  { id: "BR-006", name: "Los Angeles - Silver Lake", city: "Los Angeles", region: "West" },
  { id: "BR-007", name: "Houston - Midtown", city: "Houston", region: "South" },
  { id: "BR-008", name: "Phoenix - Arcadia", city: "Phoenix", region: "West" },
  { id: "BR-009", name: "Philadelphia - Rittenhouse", city: "Philadelphia", region: "Northeast" },
  { id: "BR-010", name: "San Antonio - Alamo Heights", city: "San Antonio", region: "South" },
  { id: "BR-011", name: "San Diego - La Jolla", city: "San Diego", region: "West" },
  { id: "BR-012", name: "Dallas - Uptown", city: "Dallas", region: "South" },
  { id: "BR-013", name: "Austin - East Side", city: "Austin", region: "South" },
  { id: "BR-014", name: "Seattle - Capitol Hill", city: "Seattle", region: "West" },
  { id: "BR-015", name: "Denver - LoDo", city: "Denver", region: "West" },
];

/** Under-replenished fast movers. */
export const CHRONIC_BRANCH_IDS = ["BR-004", "BR-005", "BR-009"] as const;
/** Over-allocated fast movers. */
export const EXCESS_BRANCH_IDS = ["BR-011", "BR-012", "BR-013", "BR-014"] as const;

export const PRODUCT_COUNT = 500;
export const DAY_COUNT = 120;
export const SEED = 20261111;
export const END_DATE = "2026-11-11";
/** First 60 SKUs are the fast range used to plant imbalance. */
export const FAST_SKU_COUNT = 60;
/** Last 8 SKUs barely sell and sit in every branch. */
export const FAILED_SKU_START = 492;
export const PROMO_SKU = "SKU-00042";
export const PROMO_DAY_START = 64;
export const PROMO_DAY_END = 70;
export const PROMO_MULTIPLIER = 5;

export function categoryFor(productIndex: number): CategorySpec {
  const category = CATEGORIES[productIndex % CATEGORIES.length];
  if (!category) throw new Error(`missing category for product ${productIndex}`);
  return category;
}

/**
 * Builds a deterministic, human-readable product name following `docs/NAMING.md`:
 * `<Brand/Line> <Product Type>, <Variant>` (Title Case, <= 60 chars, category-matched units,
 * unique across all 500 SKUs without ever embedding the SKU code or price).
 */
export function productName(productIndex: number): string {
  const category = categoryFor(productIndex);
  const slot = Math.floor(productIndex / CATEGORIES.length);
  const itemIndex = slot % category.items.length;
  const item = category.items[itemIndex] ?? category.items[0]!;
  const variantIndex = Math.floor(slot / category.items.length) % item.variants.length;
  const variant = item.variants[variantIndex] ?? item.variants[0];
  const brandIndex = (slot + variantIndex) % category.brands.length;
  const brand = category.brands[brandIndex] ?? category.brands[0];
  return `${brand} ${item.name}, ${variant}`;
}

export function formatProductDisplayName(name: string | null | undefined, sku: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed.length > 0 ? trimmed : sku;
}

export function matchesProductQuery(
  item: { sku: string; name?: string | null; productName?: string | null },
  rawQuery: string,
): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (q.length === 0) return true;
  const label = (item.productName ?? item.name ?? "").toLowerCase();
  return item.sku.toLowerCase().includes(q) || label.includes(q);
}

export function skuCode(productIndex: number): string {
  return `SKU-${String(productIndex + 1).padStart(5, "0")}`;
}

export function isFastSku(productIndex: number): boolean {
  return productIndex < FAST_SKU_COUNT;
}

export function isFailedSku(productIndex: number): boolean {
  return productIndex >= FAILED_SKU_START;
}

export function isChronicBranch(branchId: string): boolean {
  return (CHRONIC_BRANCH_IDS as readonly string[]).includes(branchId);
}

export function isExcessBranch(branchId: string): boolean {
  return (EXCESS_BRANCH_IDS as readonly string[]).includes(branchId);
}
