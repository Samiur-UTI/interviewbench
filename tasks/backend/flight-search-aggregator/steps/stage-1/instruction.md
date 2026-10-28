# Fix the search results

You've joined the flights team at an online travel agency. This repo is `flight-search`: the
service behind the flight results page for B2C customers (website and app) and B2B travel agents
(agent portal). It asks three fare suppliers at once (Caravel, Tessera and Keystone, see
`src/suppliers/`), turns their deeply nested responses into one `Itinerary` shape, merges
duplicates and sorts the results. Read `README.md` first: it lists the business rules and this
repo's TypeScript constraints.

Two tickets landed this week:

1. **Results QA:** "On some multi-city searches the same flights are listed twice, at two
   different prices: one copy from Tessera and one from another supplier. The results card of the
   Tessera copy shows a negative travel time (we saw −280 minutes on a Dubai–Singapore–Dubai
   search for 2 adults and a child), and its connecting flight seems to leave before the previous
   one lands. We captured Tessera's response for that search:
   `dev/captures/tessera-qa-4471.json`."
2. **Bookings:** "Some Caravel and Keystone bookings fail the price check with PRICE_MISMATCH:
   our total is a cent lower than the supplier's. Tessera bookings never fail this way."

Find the root causes and fix them. Keep the public API in `src/index.ts` unchanged.

Run the tests with `npm test`. Write what you found, and why it happened, in `NOTES.md`.
