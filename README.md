# StockFlow

StockFlow helps retail teams decide what to do with stock each morning. It uses sales and shelf counts to answer three questions: **Can another store spare this product? Should we reorder it? Would a markdown help clear the surplus?** It ranks those actions by estimated net benefit in Bahraini dinars (BD), including freight for transfers.

The demo covers **15 Bahrain branches, 500 products, and 120 days of synthetic history**. Daily reporting follows Bahrain time (UTC+3).

## Who uses it?

| Role | Where they start | What they can do |
| --- | --- | --- |
| **Company admin** | Network overview | See which stores reported today, review shortages and transfers across the network, and manage branches, products, and users. |
| **Branch manager** | Overview of assigned stores | Review recommendations, approve stock releases, request replenishment, and resolve issues flagged by staff. Open **Reports and trends** for stockout rates and financial estimates. |
| **Store staff** | Store inventory | Record units sold and closing stock, flag a shelf issue, track its resolution, and confirm deliveries. Staff see operational quantities for their assigned stores. |

### Follow one transfer

Suppose a store in Manama is running low on an item that another branch can spare. The manager opens **Daily work**, selects the shortage, and reviews the suggested transfer. The sending branch can approve the quantity it can release. Once committed, those units are reserved at the sending branch and appear as incoming at the receiving store. Staff open **Receive deliveries** when the stock arrives. The audit history records who acted, when, and why a quantity changed.

## Run the local demo

Use **Node.js 24.15 or later in the 24.x series** and **pnpm 12**. From the repository root:

1. Install the workspace dependencies.

   ```sh
   pnpm install --frozen-lockfile
   ```

2. Create a local `.env` file in the repository root. Enable sign-in and replace the placeholder with a private, randomly generated value. Leave `MONGODB_URI` empty for the in-memory demo.

   ```dotenv
   AUTH_ENABLED=true
   JWT_SECRET=<replace-with-a-random-secret-of-at-least-32-characters>
   MONGODB_URI=
   ```

3. Start the API and web app together.

   ```sh
   pnpm dev
   ```

4. Open the [local app](http://localhost:5173/). Expand **Demo accounts**, choose **Use** beside a role, then select **Sign in**. Try Manager to review an action, or Staff to record a stock count.

The in-memory demo supplies its own dataset and accounts. Restarting the API resets your changes. To check which storage mode is active, open [API health](http://localhost:3001/api/health).

## Use MongoDB for persistence

Set `MONGODB_URI` in the root `.env` to a MongoDB instance dedicated to this demo. The API uses the **`stockflow` database**. Use a replica set if you want order approvals and CSV batches to have multi-document transaction guarantees.

**Seeding replaces existing StockFlow demo data on that instance**, including sales entries, orders, and branches created in the UI. For a fresh demo database, stop the API, then run:

```sh
pnpm seed:mongo
pnpm dev
```

The seed creates the dataset, initial plan, and demo users. Subsequent starts only need `pnpm dev`. Check [database health](http://localhost:3001/api/health/db) to verify connectivity.

## How stock data becomes a decision

| Stage | What happens |
| --- | --- |
| **Record** | Staff enter sales and closing stock. Managers and admins can also preview a CSV, inspect row errors, and see which entries it will insert or update. A reported zero sale and a missing report carry different meanings in the forecast. |
| **Plan** | The engine estimates demand and compares stock across the entire network before filtering results to each user's branches. This lets a manager see a transfer involving an assigned store even when the other branch is outside their area. |
| **Approve** | A suggestion leaves inventory available. Committing a transfer reserves the sending store's units. The order keeps the original recommendation alongside the approved quantity and its event history. |
| **Refresh** | Physical updates such as a new shelf count refresh the stock plan. An order decision updates reservations and the queue independently. MongoDB stores sales history, entries, orders, and audit events and caches the latest plan versions. |

Estimated gains and simulated comparisons are planning figures. Realized savings depend on actual sales, fulfilment, and delivery costs. See the [forecasting assumptions and worked example](docs/ENGINE.md).

## Development

| Workspace | Responsibility |
| --- | --- |
| [`apps/web`](apps/web) | React, Vite, and Tailwind CSS. Role-specific screens for daily work, store inventory, and reporting. |
| [`apps/api`](apps/api) | Node.js and Fastify. Authentication, branch permissions, import validation, order transitions, and memory or MongoDB storage through repository interfaces. |
| [`packages/core`](packages/core) | Pure TypeScript forecasting, transfer matching, order rules, shared Zod schemas, and deterministic demo data. |

| Command | Purpose |
| --- | --- |
| `pnpm test` | Run core, API, and web tests, including isolated MongoDB tests. |
| `pnpm test:e2e` | Run Playwright browser checks. Install Chromium once with `pnpm exec playwright install chromium`. |
| `pnpm lint` | Check code style and UI conventions. |
| `pnpm typecheck` | Check TypeScript across the workspace. |
| `pnpm build` | Run workspace builds and produce the web production bundle. |
| `pnpm bench:cold` | Measure initial plan loading and subsequent reads. |

For hosting, the repository includes a [Vercel configuration](vercel.json) that routes `/api/*` to Fastify and other requests to the web app. The demo sign-in panel can be hidden with the web build variable `VITE_SHOW_DEMO_ACCOUNTS=false`. Demo accounts remain valid until their credentials or account status change.

## Further reading

- [Demo walkthrough](docs/DEMO.md) — a guided tour of the seeded scenario.
- [API reference](docs/API.md) — endpoints and role permissions.
- [Architecture decisions](docs/ADR.md) and [known limitations](docs/DECISIONS.md) — design choices and trade-offs.
- [Frontend guide](docs/FRONTEND.md) — routes, shared components, and UI conventions.
