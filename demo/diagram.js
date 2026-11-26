const svgNS = "http://www.w3.org/2000/svg";
const byId = (id) => document.getElementById(id);

const runtime = "apps/api/src/services/runtimeState.ts";
const orders = "apps/api/src/services/orderService.ts";
const policy = "packages/core/src/orders.ts";
const repository = "apps/api/src/repositories/mongo.ts";
const queue = "apps/web/src/features/queue/OrderDrawer.tsx";
const overview = "apps/web/src/features/overview/ManagerOverview.tsx";
const chat = "apps/api/src/services/stockChat.ts";
const widget = "apps/web/src/components/shared/StockChat.tsx";
const endpoint = "apps/api/src/routes/brief.ts";
const engine = "packages/core/src/engine/";

function step(node, actor, action, explanation, source, input, outcome) {
  return { node, actor, action, explanation, source, input, outcome };
}

// Traces describe calls and handoffs between logical components, including functions
// inside the same Node.js process. Example quantities are local presentation data.
const plan = {
  open: step("web", "Branch manager", "Open the morning overview", "The browser requests a scoped overview. The signed-in account identifies which branches this manager can see.", overview, "Manager session and selected branch", "Overview request sent to the Fastify API"),
  check: step("runtime", "Node.js · stock runtime", "Can the API reuse a plan?", "The runtime compares the physical data version with the plan version. After a stock change it asks the repository for the dataset and a cache entry matching the new version.", runtime, "A physical stock update advanced dataVersion", "Look up the plan by its exact data version"),
  miss: step("storage", "Stock repository", "Return the network dataset", "The repository returns the stock, product, branch and sales records. This example has no saved plan for the new version.", repository, "Requested data version and plan cache", "Dataset available · cache miss"),
  hit: step("storage", "Stock repository", "Find the matching cached plan", "A plan already exists for the requested version. The repository returns that plan to the runtime.", repository, "Requested data version and plan cache", "Dataset available · cache hit"),
  run: step("runtime", "Node.js · stock runtime", "Start a network-wide calculation", "The runtime passes the complete dataset to the pure TypeScript engine. Branch scoping happens after matching so a donor outside the manager’s stores can still help a store inside them.", runtime, "Dataset and cache miss", "All store positions enter classification"),
  reuse: step("runtime", "Node.js · stock runtime", "Reuse the matching plan", "The runtime installs the cached analysis for this version. Classification, matching and ranking can all be skipped.", runtime, "Cached plan version matches dataVersion", "Network recommendations ready to scope"),
  risk: step("classify", "Core engine · position classifier", "Which stores need stock?", "With stock history available, the classifier checks excess cover first, then compares units on hand with the reorder point. An at-risk store becomes a potential receiver.", engine+"classify.ts", "Example receiver has 10 units and a reorder point of 35", "Receiver classified AT_RISK"),
  excess: step("classify", "Core engine · position classifier", "Is any store a receiver?", "The engine checks every branch for the SKU. In this example one store has excess cover and spare units, and every other store has enough stock.", engine+"classify.ts", "Overstock at one branch · no at-risk branch", "Donor surplus available · zero receivers"),
  match: step("rank", "Core engine · transfer matcher", "Is moving the stock worthwhile?", "The matcher compares eligible donor–receiver pairs. It chooses the highest positive net benefit, deducts the matched quantity from the available surplus and repeats while a qualifying pair remains.", engine+"match.ts", "Example quote for 20 units over 10 km: BD 24.000 avoided margin + BD 1.000 holding savings − BD 8.000 freight", "BD 17.000 net benefit · create a TRANSFER draft"),
  reorder: step("rank", "Core engine · recommendation builder", "How much should the store reorder?", "After matching, the engine checks the remaining gap to the higher of the 14-day stock target and the reorder point. A positive gap produces a supplier reorder.", engine+"recommend.ts", "Example target 70 units · 10 on hand · no eligible donor", "REORDER draft for 60 units"),
  markdown: step("rank", "Core engine · recommendation builder", "Should the surplus be discounted?", "The engine considers a markdown when the SKU has surplus and there are zero network receivers. It estimates the carrying savings and markdown cost, then includes the draft in the ranking.", engine+"recommend.ts", "Eligible donor surplus · no network receiver", "MARKDOWN draft with an estimated net benefit"),
  ranked: step("runtime", "Node.js · stock runtime", "Receive the ranked network plan", "The recommendation builder orders drafts by net benefit. The runtime requests a cache write for the data version used in that calculation.", runtime, "Ranked transfers, reorders and markdowns", "Versioned plan ready to persist"),
  save: step("storage", "Stock repository", "Cache the network plan", "The repository saves the computed plan so future requests for the same physical data version can reuse it.", repository, "Network plan and matching version", "Reusable plan saved"),
  ready: step("runtime", "Node.js · stock runtime", "Make the plan available to services", "The runtime makes the network analysis available for the manager’s overview.", runtime, "Latest dataset and network analysis", "Current plan ready for a scoped read"),
  scope: step("scope", "Node.js · scope and KPI services", "Which recommendations can the manager see?", "A transfer qualifies for branch visibility when the manager covers the donor or the receiver. Reorders and markdowns use the target branch. Recommendation filtering also applies the BD 9.500 minimum net benefit.", "apps/api/src/services/scope.ts", "Network plan, authenticated role and assigned branches", "Scoped priorities and KPIs"),
  show: step("web", "Branch manager", "Review the scoped priorities", "The manager sees the results and can open the queue to review a suggested action. A recommendation still needs an authorized order decision.", overview, "Overview response", "Manager can inspect the recommendation"),
};
const order = {
  approve: step("web", "Donor branch manager", "Choose the quantity to release", "The receiving store has requested 20 units. The donor manager chooses 15 and records truck capacity as the reason. This is the human approval decision.", queue, "AWAITING_DONOR · suggested 20 · approved 15", "COMMIT request with reason TRUCK_CAPACITY"),
  request: step("service", "Node.js · order service", "Load the order and its ownership", "The service synchronizes the order, identifies the caller’s branches and asks the shared transition rules whether this caller may commit it.", orders, "Signed-in donor manager and current order", "Evaluate COMMIT against AWAITING_DONOR"),
  allow: step("policy", "Core · order transition rules", "May this manager release the transfer?", "The transition table checks the action, current state and branch ownership. In this example the manager owns the donor branch for an awaiting transfer.", policy, "Manager owns source · state AWAITING_DONOR", "COMMIT permitted · proposed state COMMITTED"),
  qty: step("service", "Node.js · order service", "Is the edited quantity valid?", "A transfer needs a whole quantity from the minimum lot of 5 up to the original suggested quantity. A change also requires a recognized reason. The original engine snapshot stays available for audit.", orders, "15 units within the range 5–20 · reason supplied", "Quantity validated · check current donor surplus"),
  reserve: step("allocation", "Order service · stock allocation", "Can the donor spare 15 units now?", "The service checks surplus after existing reservations. It stages a donor reservation and incoming units at the receiver before saving, so a competing request sees the allocation.", orders, "15 requested · at least 15 spare after reservations", "Stage +15 donor reserved and +15 receiver in transit"),
  short: step("allocation", "Order service · stock allocation", "Stop when the donor has too little surplus", "An earlier order has used some of the donor’s surplus. The service checks the current position again at commit time and refuses this release.", orders, "15 requested · only 8 spare", "409 Conflict · no new reservation or commit event"),
  saved: step("storage", "Order repository", "Save the decision and its event together", "The write checks the expected order state and allocation revision. It records the actor, approved quantity, engine quantity and reason in the order history.", repository, "Expected AWAITING_DONOR · approved 15 of 20", "COMMITTED order and immutable COMMIT event"),
  clash: step("storage", "Order repository", "Detect a competing update", "A different writer has changed the order or allocation revision since this request read it. The guarded write reports a conflict.", repository, "Stale expected state or allocation revision", "This write did not commit"),
  rollback: step("service", "Node.js · order service", "Undo this request’s staged reservation", "The service reverses its temporary deltas, reloads the authoritative order state and reports a conflict.", orders, "Repository returned a conflicting write", "409 Conflict · this request’s staged deltas removed"),
  reject: step("service", "Node.js · order service", "Return the allocation conflict", "The service reports the failed surplus check to the caller. A smaller quantity or a different donor would need a new decision.", orders, "Insufficient donor surplus", "Request ends before persistence"),
  retry: step("web", "Donor branch manager", "Review the conflict", "The manager can review current availability and order history before deciding what to do next.", queue, "409 Conflict response", "This approval attempt ends here"),
  committed: step("service", "Node.js · order service", "Refresh the decision view", "After the successful write the service advances decisionVersion and clears scoped KPI results. The physical dataset and cached morning plan retain their version.", orders, "Saved order and event", "15 units recorded in transit"),
  delivery: step("web", "Receiving store team", "Confirm the goods arrived", "An authorized receiving team member checks the physical delivery and selects Mark received.", queue, "15 delivered units · order COMMITTED", "RECEIVE request from the destination branch"),
  validateReceipt: step("receipt", "Order service · receiving", "Is this receipt allowed?", "The receive handler enforces the shared transition rules for the caller, destination branch and committed state, then requests persistence of the receipt.", orders, "Authorized receiver · COMMITTED transfer", "Proposed state RECEIVED"),
  received: step("storage", "Order repository", "Record receipt of the transfer", "The order and its receipt event are persisted together against the expected committed state.", repository, "Expected COMMITTED · RECEIVE event", "RECEIVED order saved"),
  clear: step("receipt", "Order service · receiving", "Clear incoming units", "The receipt removes the 15 delivered units from the receiver’s in-transit total. The donor reservation persists until physical stock refreshes.", orders, "Saved receipt · 15 previously in transit", "Receiver in-transit overlay reduced by 15"),
  finish: step("web", "Receiving store team", "Inspect the completed transfer", "Order history now shows who approved the edited quantity and who confirmed receipt.", queue, "Received order and events", "Transfer complete"),
};
const ai = {
  ask: step("web", "Branch manager", "Ask which products are running low", "The React chat panel sends a question about the manager’s stores to the read-only assistant.", widget, "“Which products are running low in my stores?”", "POST /api/ai/chat"),
  auth: step("api", "Node.js · Fastify chat route", "May this caller use stock chat?", "The route requires sign-in and catalog access. It validates the request body and supplies the authenticated user to the assistant.", endpoint, "Session, role and chat request", "Validated request and trusted user identity"),
  scoped: step("assistant", "Node.js · stock assistant", "Which branches may this answer use?", "The assistant checks branch IDs, named stores and follow-up context against the caller’s scope. This request can use the manager’s assigned active stores.", chat, "Authenticated manager and requested branches", "Authorized store set established"),
  denied: step("assistant", "Node.js · stock assistant", "Reject the out-of-scope lookup", "An explicitly requested branch falls outside the manager’s assignments. The assistant stops before interpreting the question or collecting answer facts.", chat, "Requested branch outside the authorized set", "Forbidden · skip the provider and fact lookup"),
  model: step("provider", "Optional AI provider", "Propose a lookup intent", "For this question the configured provider receives the question and limited interpretation context. It proposes a supported topic. Stock quantities come from the application’s scoped records.", "apps/api/src/services/modelOutput.ts", "Question, allowed intent schema and permitted context", "Proposed topic: shortages"),
  validate: step("intent", "Node.js · intent validation", "Can the proposed intent be used?", "The assistant parses the provider output against ChatIntentSchema and checks the interpretation against the question before dispatching a permitted lookup.", chat, "Structured shortages intent", "Validated shortage lookup"),
  local: step("intent", "Node.js · local intent rules", "Interpret a supported question locally", "With no provider configured, the assistant uses its built-in interpretation. The same role and branch restrictions apply.", chat, "Low-stock question · records-only mode", "Locally resolved shortage lookup"),
  facts: step("facts", "Node.js · brief facts service", "Select facts the caller can see", "StockFlow collects role-appropriate records for the authorized stores. The shortage lookup selects facts about short stock cover. Staff answers use permitted operational facts.", "apps/api/src/services/briefFacts.ts", "Shortage intent and authorized store IDs", "Scoped shortage facts and an as-of time"),
  answer: step("api", "Node.js · Fastify chat route", "Validate the answer envelope", "The route checks the response schema before returning the summary, facts and as-of time to the browser.", endpoint, "Answer built from approved records", "Read-only chat response"),
  forbidden: step("api", "Node.js · Fastify chat route", "Return the access decision", "The route maps the branch-scope error to a forbidden response.", endpoint, "Branch outside assigned stores", "HTTP 403 · no stock facts returned"),
  display: step("web", "Branch manager", "Read the answer", "The panel displays the authorized shortage information. To act on the information, the manager uses the separate governed order workflow.", widget, "Scoped chat response", "Manager can review stock conditions"),
  blocked: step("web", "Branch manager", "See the access result", "This question ends without disclosing stock for the unassigned branch.", widget, "Forbidden response", "No branch data displayed"),
};
function decision(owner, question, rule, input, yes, no) {
  return { ...owner, action: question, explanation: rule, input, outcome: "Choose a branch to trace its outcome.", branches: { Yes: yes, No: no } };
}

plan.check = decision(plan.check, "Does a plan match this data version?",
  "The Node.js runtime checks the plan cache for the current physical data version. A match can skip the network calculation.",
  "Current data version and saved plan version", [plan.hit, "Reuse cached plan"], [plan.miss, "Load stock records"]);
plan.receiver = decision(plan.risk, "Does this SKU have an at-risk receiver?",
  "The classifier checks every branch before matching. This example has spare units at a donor. Whether another store needs the SKU determines which action the engine considers.",
  "Network positions for one SKU", [plan.risk, "Evaluate the shortage"], [plan.excess, "Evaluate surplus"]);
plan.quote = decision(plan.match, "Is there a qualifying transfer?",
  "A donor must have enough spare units for the minimum lot. The transfer must also save more in margin and carrying costs than it spends on freight. In this example an unmet shortage requires a reorder if no quote qualifies.",
  "Donor surplus, receiver need, minimum lot and transfer costs", [plan.match, "Recommend transfer"], [plan.reorder, "Calculate reorder"]);

order.forbidden = step("policy", "Core · order transition rules", "Deny the release", "In this example the manager does not own the donor branch. The order service enforces the ownership decision and returns a forbidden response.", policy, "Cross-branch transfer · caller outside donor scope", "HTTP 403 · no stock reserved");
order.invalid = step("service", "Node.js · order service", "Reject the quantity change", "For a 20-unit transfer suggestion, approving 21 exceeds the permitted range. The request ends before the service stages a reservation.", orders, "Suggested 20 · attempted 21", "Validation error · order stays AWAITING_DONOR");
order.approve = { ...order.approve, actor: "Branch manager", action: "Review a requested transfer", explanation: "A receiving store has requested 20 units. A manager submits a release decision. The following checks determine whether the service can commit it.", input: "AWAITING_DONOR · suggested quantity 20", outcome: "COMMIT request sent to the order service" };
order.request = { ...order.request, input: "Signed-in manager and current order" };
order.permission = decision(order.allow, "Does the manager own the donor branch?",
  "For this transfer between separately managed branches, the shared transition rules check the manager’s ownership of the donor before allowing release.",
  "Manager assignments · transfer AWAITING_DONOR", [order.allow, "Allow release"], [order.forbidden, "Deny release"]);
order.quantity = decision(order.qty, "Are the quantity and reason valid?",
  "The approved transfer quantity must be a whole number between 5 and the suggested quantity. An edited quantity also needs a valid reason.",
  "Original suggestion of 20 units · manager’s edit and reason", [order.qty, "Accept 15 units"], [order.invalid, "Reject invalid edit"]);
order.surplus = decision(order.reserve, "Can the donor still spare 15 units?",
  "Stock allocation checks what is available after earlier reservations. A previously valid recommendation can exceed the stock available now.",
  "Approved quantity 15 · current unreserved donor surplus", [order.reserve, "Stage reservation"], [order.short, "Return conflict"]);
order.write = decision(order.saved, "Does the stored revision still match?",
  "The repository checks the expected state and allocation revision when it writes the order and event. A competing update can invalidate this request.",
  "Expected revision and order state at write time", [order.saved, "Save commitment"], [order.clash, "Handle conflict"]);

ai.ask = { ...ai.ask, action: "Ask about stock at a store", explanation: "A manager asks about products running low. The chat request carries the question and optional branch context. The server uses the signed-in account to check access.", input: "Low-stock question and requested store" };
ai.scope = decision(ai.scoped, "Is the requested branch in scope?",
  "The assistant checks the requested branch against the manager’s assignments before interpreting the question or looking up stock facts.",
  "Authenticated manager · requested branch", [ai.scoped, "Authorize lookup"], [ai.denied, "Deny access"]);
ai.provider = decision({ ...ai.scoped, source: "apps/api/src/services/modelOutput.ts" }, "Is an AI provider configured?",
  "For this supported question, the assistant can ask the configured provider to propose an intent. In records-only mode, the local interpreter can resolve this question.",
  "Authorized question · server-side provider configuration", [ai.model, "Ask provider"], [ai.local, "Use local rules"]);

function scenario(label, stages, keys) {
  return { label, steps: keys.split(" ").map(key => stages[key]) };
}

const maps = {
  plan: {
    title: "How a stock recommendation is chosen",
    nodes: [
      ["web", "Store workspace", "React · manager overview", "web"],
      ["runtime", "Plan runtime", "Node.js · cache or compute", "api"],
      ["storage", "Plan repository", "Storage · dataset and cache", "store"],
      ["scope", "Branch scope", "Node.js · visible actions", "api"],
      ["rank", "Action selection", "Core · match and rank", "engine"],
      ["classify", "Stock classification", "Core · need and surplus", "engine"],
    ],
    scenarios: [
      scenario("Profitable transfer", plan, "open check miss run receiver risk quote match ranked save ready scope show"),
      scenario("No eligible donor", plan, "open check miss run receiver risk quote reorder ranked save ready scope show"),
      scenario("Surplus without a receiver", plan, "open check miss run receiver excess markdown ranked save ready scope show"),
      scenario("Matching cached plan", plan, "open check hit reuse scope show"),
    ],
  },
  order: {
    title: "Who authorizes a stock transfer",
    nodes: [
      ["web", "Store workspace", "People · approve and receive", "web"],
      ["service", "Order service", "Node.js · quantity and state", "api"],
      ["policy", "Transition rules", "Core · role and ownership", "engine"],
      ["receipt", "Receipt handler", "Node.js · receiving branch", "api"],
      ["storage", "Order repository", "Storage · order and event", "store"],
      ["allocation", "Stock allocation", "Node.js · reserve surplus", "engine"],
    ],
    scenarios: [
      scenario("Approve and receive", order, "approve request permission allow quantity qty surplus reserve write saved committed delivery validateReceipt received clear finish"),
      scenario("Release denied", order, "approve request permission forbidden"),
      scenario("Invalid quantity", order, "approve request permission allow quantity invalid"),
      scenario("Insufficient donor stock", order, "approve request permission allow quantity qty surplus short reject retry"),
      scenario("Concurrent write conflict", order, "approve request permission allow quantity qty surplus reserve write clash rollback retry"),
    ],
  },
  ai: {
    title: "How a question becomes a scoped answer",
    nodes: [
      ["web", "Chat workspace", "React · store question", "web"],
      ["api", "Chat route", "Node.js · Fastify", "api"],
      ["assistant", "Branch authorization", "Node.js · stock assistant", "api"],
      ["facts", "Fact lookup", "Node.js · approved records", "store"],
      ["intent", "Intent validation", "Node.js · schema and rules", "engine"],
      ["provider", "AI provider", "Optional · Gemini or OpenAI", "model"],
    ],
    scenarios: [
      scenario("Provider-assisted lookup", ai, "ask auth scope scoped provider model validate facts answer display"),
      scenario("Local interpretation", ai, "ask auth scope scoped provider local facts answer display"),
      scenario("Unassigned branch", ai, "ask auth scope denied forbidden blocked"),
    ],
  },
};

const icons = {
  web: "M3 4h18v13H3z M8 21h8 M12 17v4",
  api: "M3 3h18v7H3z M3 14h18v7H3z M6 6.5h1 M6 17.5h1 M16 6.5h2 M16 17.5h2",
  engine: "M3 4v16h18 M6 15l4-5 4 2 6-7 M16 5h4v4",
  store: "M4 6a8 3 0 1 0 16 0a8 3 0 1 0-16 0 M4 6v12c0 4 16 4 16 0V6 M4 12c0 4 16 4 16 0",
  model: "m11 4 2.2 5.8L19 12l-5.8 2.2L11 20l-2.2-5.8L3 12l5.8-2.2z M19 2v5 M16.5 4.5h5",
};

const canvas = document.querySelector(".canvas");
const chart = byId("map");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let flow = "plan";
let caseIndex = 0;
let index = 0;
let playing = false;
let timer;
let frame;
const sequence = () => maps[flow].scenarios[caseIndex].steps;

function make(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function svgElement(name, attributes) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function icon(kind, isDecision) {
  const box = make("span", isDecision ? "symbol decision-symbol" : "symbol");
  const svg = svgElement("svg", { viewBox: "0 0 24 24", "aria-hidden": true });
  const d = isDecision ? "M12 2 22 12 12 22 2 12Z M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5 M12 17h.01" : icons[kind];
  svg.append(svgElement("path", { d, class: "icon" }));
  box.append(svg);
  return box;
}

function selectedAnswer(i) {
  const steps = sequence();
  return Object.keys(steps[i].branches).find(answer => steps[i].branches[answer][0] === steps[i + 1]);
}

function answerButtons(i, inspector = false) {
  const group = make("div", "branch-options");
  const gate = sequence()[i];
  for (const [answer, [, caption]] of Object.entries(gate.branches)) {
    const button = make("button", "branch-option " + answer.toLowerCase());
    button.append(make("strong", "", answer), make("span", "", caption));
    button.setAttribute("aria-label", answer + " — " + caption);
    button.setAttribute("aria-pressed", String(selectedAnswer(i) === answer));
    button.onclick = () => choose(i, answer, inspector);
    group.append(button);
  }
  return group;
}

// Coordinates are percentages of the chart width, so both fork lanes line up
// with their HTML controls at any viewport size.
function wires(paths) {
  const svg = svgElement("svg", { viewBox: "0 0 100 32", preserveAspectRatio: "none", class: "wires", "aria-hidden": true });
  for (const [key, d] of paths) {
    svg.append(svgElement("path", { d, "data-route": key, "vector-effect": "non-scaling-stroke" }));
  }
  return svg;
}

function drawMap() {
  const map = maps[flow];
  const rows = sequence().map((step, i) => {
    const row = make("div", "flow-row");
    const [, component, , kind] = map.nodes.find(([key]) => key === step.node);
    const card = make("button", "unit " + kind);
    card.id = "step-" + i;
    card.setAttribute("aria-label", "Inspect step " + (i + 1) + ". " + step.action);
    const words = make("span", "card-words");
    words.append(make("span", "component", component), make("strong", "", step.action));
    card.append(icon(kind, Boolean(step.branches)), words);
    card.onclick = () => arrive(i);
    row.append(card);
    if (step.branches) {
      const route = selectedAnswer(i);
      row.append(
        wires([["Yes", "M50 0 V12 H25 V32"], ["No", "M50 0 V12 H75 V32"]]),
        answerButtons(i),
        wires([[route, "M" + (route === "Yes" ? 25 : 75) + " 0 V15 H50 V32"]])
      );
    } else if (i < sequence().length - 1) {
      row.append(wires([["next", "M50 0 V32"]]));
    }
    return row;
  });
  const pulse = make("i", "pulse");
  pulse.id = "pulse";
  pulse.hidden = true;
  chart.replaceChildren(...rows, pulse);
  byId("map-heading").textContent = map.title;
  byId("stage").replaceChildren(...sequence().map((s, i) => new Option(`${i + 1}. ${s.action}`, String(i))));
}

function cancelMotion() {
  clearTimeout(timer);
  cancelAnimationFrame(frame);
  playing = false;
  byId("pulse").hidden = true;
  chart.querySelectorAll(".travelling").forEach(path => path.classList.remove("travelling"));
}

function follow(i) {
  const row = chart.children[i];
  const box = row.getBoundingClientRect();
  const view = canvas.getBoundingClientRect();
  if (box.top < view.top + 12 || box.bottom > view.bottom - 12) {
    canvas.scrollTop += box.top - view.top - 20;
  }
}

function arrive(i, autoplay = false) {
  cancelMotion();
  index = i;
  const steps = sequence();
  const step = steps[i];
  const last = i === steps.length - 1;
  playing = autoplay && !last && !step.branches;
  chart.querySelector(".active")?.classList.remove("active");
  chart.querySelector("[aria-current]")?.removeAttribute("aria-current");
  const card = byId("step-" + i);
  card.classList.add("active");
  card.setAttribute("aria-current", "step");
  for (const key of ["actor", "action", "explanation", "input", "outcome", "source"]) byId(key).textContent = step[key];
  byId("result-label").textContent = step.branches ? "Decision" : "Outcome";
  byId("count").textContent = "Step " + (i + 1) + " of " + steps.length;
  byId("stage").value = String(i);
  byId("decision-choices").replaceChildren(...(step.branches ? [answerButtons(i, true)] : []));
  byId("back").disabled = !i;
  byId("next").disabled = last || Boolean(step.branches);
  byId("play").disabled = Boolean(step.branches);
  byId("play").textContent = playing ? "Ⅱ  Pause" : last ? "↺  Replay" : "▶  Play flow";
  follow(i);
  if (playing) timer = setTimeout(() => move(i + 1, true), 4000);
}

function choose(i, answer, inspector) {
  const current = sequence();
  const next = current[i].branches[answer][0];
  if (current[i + 1] !== next) {
    const candidates = maps[flow].scenarios;
    const candidate = candidates.findIndex(({ steps }) =>
      current.slice(0, i + 1).every((step, n) => steps[n] === step) && steps[i + 1] === next
    );
    if (candidate < 0) return;
    cancelMotion();
    caseIndex = candidate;
    byId("scenario").value = String(candidate);
    drawMap();
  }
  arrive(i);
  move(i + 1, false, inspector ? "detail" : "chart");
}

function move(target, autoplay = false, focusAfter) {
  cancelMotion();
  playing = autoplay;
  if (playing) byId("play").textContent = "Ⅱ  Pause";
  const reverse = target < index;
  const from = Math.min(target, index);
  const step = sequence()[from];
  const route = step.branches ? selectedAnswer(from) : "next";
  const paths = Array.from(chart.children[from].querySelectorAll('[data-route="' + route + '"]'));
  function finish() {
    arrive(target, autoplay);
    if (focusAfter === "chart") byId("step-" + target).focus({ preventScroll: true });
    if (focusAfter === "detail") byId("action").focus({ preventScroll: true });
  }
  if (reducedMotion.matches || Math.abs(target - index) !== 1) return finish();
  if (reverse) paths.reverse();
  chart.querySelector(".active")?.classList.remove("active");
  paths.forEach(path => path.classList.add("travelling"));
  // Sample in screen space so the pulse travels at a steady speed on stretched connectors.
  const origin = chart.getBoundingClientRect();
  const points = [];
  let distance = 0;
  for (const path of paths) {
    const matrix = path.getScreenCTM();
    const length = path.getTotalLength();
    for (let n = 0; n <= 60; n++) {
      const p = path.getPointAtLength(length * (reverse ? 1 - n / 60 : n / 60)).matrixTransform(matrix);
      const x = p.x - origin.left, y = p.y - origin.top;
      const prev = points.at(-1);
      if (prev) distance += Math.hypot(x - prev.x, y - prev.y);
      points.push({ x, y, distance });
    }
  }
  const pulse = byId("pulse");
  const start = performance.now();
  function travel(now) {
    const t = Math.min(1, (now - start) / 650);
    const at = t * distance;
    const end = points.findIndex(p => p.distance >= at);
    const a = points[Math.max(0, end - 1)];
    const b = points[end];
    const fraction = (at - a.distance) / (b.distance - a.distance || 1);
    pulse.style.left = (a.x + (b.x - a.x) * fraction) + "px";
    pulse.style.top = (a.y + (b.y - a.y) * fraction) + "px";
    pulse.hidden = false;
    if (t === 1) finish();
    else frame = requestAnimationFrame(travel);
  }
  frame = requestAnimationFrame(travel);
}

function selectScenario(selected) {
  if (byId("pulse")) cancelMotion();
  caseIndex = selected;
  drawMap();
  canvas.scrollTop = 0;
  arrive(0);
}

function selectFlow(key) {
  flow = key;
  document.querySelectorAll("[data-flow]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.flow === key));
  });
  byId("scenario").replaceChildren(...maps[key].scenarios.map((s, i) => new Option(s.label, String(i))));
  selectScenario(0);
}

byId("scenario").onchange = event => selectScenario(Number(event.target.value));
byId("stage").onchange = event => arrive(Number(event.target.value));
document.querySelectorAll("[data-flow]").forEach(button => {
  button.onclick = () => selectFlow(button.dataset.flow);
});
byId("back").onclick = () => move(index - 1);
byId("next").onclick = () => move(index + 1);
byId("play").onclick = () => {
  if (playing) arrive(index);
  else if (index === sequence().length - 1) arrive(0, true);
  else move(index + 1, true);
};
selectFlow("plan");
