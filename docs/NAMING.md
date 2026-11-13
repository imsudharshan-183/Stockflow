# Product Naming Standard

This document defines the naming rules for StockFlow's catalog (`packages/core/src/seed/catalog.ts` and any admin-created products).

## Format

```
<Brand/Line> <Product Type>, <Variant>
```

- **Title Case** throughout, except standard lowercase metric/imperial unit symbols (`ml`, `g`, `kg`, `oz`, `qt`, `in`, `ft`, `pcs`).
- **Maximum length:** `60` characters (`3` to `60` characters, trimmed).
- **Never embed the SKU code or price** inside `name`. The SKU (`SKU-00001`..`SKU-00500`) is the immutable product identifier and is always rendered as a separate muted label alongside the product name.
- **Uniqueness:** Product names must be unique within their category (case-insensitive) and unique across all 500 seeded SKUs.
- **Fictional brands only:** Use plausible fictional house/line brands (`Aurelia`, `Bluepeak`, `Northfield`, `Harbor & Pine`, `Crestwood`, `Meadowbrook`, `Clearwater`, `Sunridge`, `Solstice`, `Veritas`, `Kestrel`, `Alder & Co`, `Cloverdale`, `Timberline`, `Harvest Mill`). Never use real trademarked brands.

## Category-Appropriate Variants & Units

Every product's variant must match the physical nature of its category and item type:

| Category | Brand Lines | Allowed Variant / Unit Conventions | Example |
|---|---|---|---|
| **Beverages** | Aurelia, Clearwater, Sunridge, Northfield | Volume (`250 ml`–`1.5 L`) or multipacks (`Pack of 4`–`Pack of 12`) | `Aurelia Sparkling Water, 330 ml` |
| **Snacks** | Harvest Mill, Northfield, Sunridge, Meadowbrook | Weight (`40 g`–`750 g`) or multipacks (`Pack of 4`–`Pack of 12`) | `Northfield Orchard Trail Mix, 170 g` |
| **Dairy** | Meadowbrook, Cloverdale, Northfield, Aldervale | Volume (`250 ml`–`2 L`) for milk/cream; weight (`115 g`–`1 kg`) for cheese/yogurt/butter | `Meadowbrook Organic Whole Milk, 500 ml` |
| **Household** | Northfield, Clearwater, Harbor & Pine, Crestwood | Volume (`350 ml`–`3 L`) for liquids; count (`15 pcs`–`80 pcs`, `Pack of 2`–`Pack of 16`) for paper/bags/sponges | `Northfield Liquid Dish Soap, 350 ml` |
| **Personal Care** | Aurelia, Solstice, Veritas, Clearwater | Volume (`50 ml`–`1 L`), weight (`85 g`–`200 g`), or multipacks (`Pack of 2`–`Pack of 6`) | `Aurelia Botanical Shampoo, 200 ml` |
| **Stationery** | Veritas, Kestrel, Alder & Co, Crestwood | Sheet count (`80 Sheets`–`400 Sheets`), ring size (`1 in`–`3 in`), or pack count (`50 pcs`–`500 pcs`, `Pack of 4`–`Pack of 50`) | `Veritas Ruled Hardcover Notebook, 80 Sheets` |
| **Toys** | Bluepeak, Northfield, Crestwood, Sunridge | Piece count (`24 pcs`–`1000 pcs`), plush height (`8 in`–`20 in`), or edition/pack (`Classic Edition`, `Pack of 2`–`Pack of 10`) | `Bluepeak Wooden Building Blocks, 40 pcs` |
| **Pet Supplies** | Timberline, Meadowbrook, Bluepeak, Northfield | Bag weight (`1 kg`–`15 kg`), treat weight (`85 g`–`600 g`), size (`Small`–`Extra Large`), length (`10 in`–`22 in`), or volume (`250 ml`–`1 L`) | `Timberline Adult Dry Dog Food, 1.5 kg` |
| **Kitchenware** | Crestwood, Alder & Co, Harbor & Pine, Veritas | Capacity (`1.5 qt`–`5 qt`, `500 ml`–`2 L`), dimensions (`8 in`–`20 in`), or sets (`Set of 2`–`Set of 8`) | `Crestwood Stainless Mixing Bowl, 1.5 qt` |
| **Home Decor** | Harbor & Pine, Solstice, Aurelia, Alder & Co | Dimensions (`14 in`–`32 in`, `4x6 in`–`12x16 in`, `2x3 ft`–`6x9 ft`), candle weight (`4 oz`–`16 oz`), or colorways | `Harbor & Pine Linen Throw Pillow, 16 in` |
| **Health & Wellness** | Veritas, Clearwater, Solstice, Aurelia | Count (`30 pcs`–`250 pcs`, `Pack of 6`–`Pack of 40`), volume (`60 ml`–`1 L`), weight (`50 g`–`200 g`), or device variant | `Veritas Buffered Vitamin C Tablets, 30 pcs` |
| **Accessories** | Harbor & Pine, Kestrel, Alder & Co, Crestwood | Apparel sizes (`S`, `M`, `L`, `XL`), colorways (`Navy`, `Olive`, `Charcoal`, `Tortoise`, `Saddle Tan`), or multipacks (`Pack of 3`–`Pack of 6`) | `Harbor & Pine Heavyweight Canvas Tote, Natural` |

## Determinism & Fallback Invariants

1. **Deterministic slot mapping:** Each category contains `8` item types × `6` item-specific variants (`48` unique combinations per category, `576` across `12` categories), indexed by `slot = Math.floor(productIndex / 12)`. This guarantees `500` unique product names with zero collisions.
2. **Engine isolation:** Changing product names never alters `sku`, `category`, `price`, `cost`, `leadTimeDays`, or the RNG draws for `sales`, `onHand`, and `demand`.
3. **Display fallback:** If a product record has an empty or whitespace name, `formatProductDisplayName(name, sku)` returns `sku` so no UI surface ever renders a blank title.
