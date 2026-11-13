import type { Branch } from "../schemas/index.js";

export interface CategorySpec {
  name: string;
  basePrice: number;
  leadTimeDays: number;
  meanDemand: number;
  nouns: readonly string[];
}

export const CATEGORIES: readonly CategorySpec[] = [
  {
    name: "Beverages",
    basePrice: 4,
    leadTimeDays: 4,
    meanDemand: 5,
    nouns: ["Sparkling Water", "Cold Brew", "Lemon Soda", "Iced Tea", "Still Water", "Orange Juice"],
  },
  {
    name: "Snacks",
    basePrice: 3.5,
    leadTimeDays: 4,
    meanDemand: 4.2,
    nouns: ["Potato Chips", "Trail Mix", "Pretzel Sticks", "Granola Bar", "Cheese Crackers", "Popcorn"],
  },
  {
    name: "Dairy",
    basePrice: 5,
    leadTimeDays: 2,
    meanDemand: 3.8,
    nouns: ["Whole Milk", "Greek Yogurt", "Cheddar Cheese", "Butter", "Cottage Cheese", "Cream"],
  },
  {
    name: "Household",
    basePrice: 8,
    leadTimeDays: 6,
    meanDemand: 2,
    nouns: ["Dish Soap", "Laundry Detergent", "Paper Towels", "Trash Bags", "All-Purpose Cleaner", "Sponges"],
  },
  {
    name: "Personal Care",
    basePrice: 7,
    leadTimeDays: 7,
    meanDemand: 1.6,
    nouns: ["Shampoo", "Bar Soap", "Toothpaste", "Body Lotion", "Face Wash", "Deodorant"],
  },
  {
    name: "Stationery",
    basePrice: 4.5,
    leadTimeDays: 8,
    meanDemand: 1.2,
    nouns: ["Notebook", "Ballpoint Pens", "Sticky Notes", "Binder", "Pencils", "Index Cards"],
  },
  {
    name: "Toys",
    basePrice: 18,
    leadTimeDays: 10,
    meanDemand: 0.7,
    nouns: ["Building Blocks", "Puzzle", "Stuffed Bear", "Board Game", "Toy Car", "Coloring Set"],
  },
  {
    name: "Pet Supplies",
    basePrice: 14,
    leadTimeDays: 9,
    meanDemand: 0.8,
    nouns: ["Dry Dog Food", "Dry Cat Food", "Training Treats", "Cat Litter", "Chew Toy", "Pet Shampoo"],
  },
  {
    name: "Kitchenware",
    basePrice: 16,
    leadTimeDays: 11,
    meanDemand: 0.55,
    nouns: ["Mixing Bowl", "Saucepan", "Spatula", "Cutting Board", "Measuring Cups", "Storage Jar"],
  },
  {
    name: "Home Decor",
    basePrice: 22,
    leadTimeDays: 12,
    meanDemand: 0.4,
    nouns: ["Throw Pillow", "Picture Frame", "Table Lamp", "Candle", "Area Rug", "Vase"],
  },
  {
    name: "Health & Wellness",
    basePrice: 12,
    leadTimeDays: 8,
    meanDemand: 0.9,
    nouns: ["Vitamin C", "First Aid Kit", "Hand Sanitizer", "Adhesive Bandages", "Pain Relief Gel", "Thermometer"],
  },
  {
    name: "Accessories",
    basePrice: 15,
    leadTimeDays: 9,
    meanDemand: 0.6,
    nouns: ["Canvas Tote", "Sunglasses", "Baseball Cap", "Belt", "Scarf", "Wallet"],
  },
];

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

const ADJECTIVES = [
  "Everyday",
  "Select",
  "Harvest",
  "Prime",
  "Clear",
  "Soft",
  "Golden",
  "Urban",
  "Classic",
  "Home",
] as const;

const SIZES = ["100g", "200g", "500g", "1kg", "5kg", "200ml", "750ml", "1L"] as const;

export function categoryFor(productIndex: number): CategorySpec {
  const category = CATEGORIES[productIndex % CATEGORIES.length];
  if (!category) throw new Error(`missing category for product ${productIndex}`);
  return category;
}

const NAME_TEMPLATES = [
  (adjective: string, noun: string, size: string) => `${adjective} ${noun} ${size}`,
  (adjective: string, noun: string, size: string) => `${noun}, ${size}, ${adjective}`,
  (adjective: string, noun: string, size: string) => `${size} ${adjective} ${noun}`,
] as const;

export function productName(productIndex: number): string {
  const category = categoryFor(productIndex);
  const adjective = ADJECTIVES[productIndex % ADJECTIVES.length] ?? "Everyday";
  const noun = category.nouns[productIndex % category.nouns.length] ?? "Item";
  const size = SIZES[(productIndex * 3) % SIZES.length] ?? "500g";
  const template = NAME_TEMPLATES[productIndex % NAME_TEMPLATES.length] ?? NAME_TEMPLATES[0];
  return template(adjective, noun, size);
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
