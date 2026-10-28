# Fix the search results

You've joined the flights team at an online travel agency. This repo is
`flight-search`: the service behind the flight results page for B2C customers (website and app)
and for B2B travel agents (agent portal). It asks every configured fare supplier at once (today
AeroLink and SkyMesh, see `src/suppliers/`), converts their very different payloads into one
`Itinerary` shape, merges duplicates and returns a sorted list. Read `README.md` first: it lists
the business rules the results must follow, and a few TypeScript constraints of this repo.

Two tickets landed this week:

1. **B2B support:** "Agents booking for corporate clients say business-class fares have
   disappeared on several routes, even though the airline sells them. Economy shows up fine for
   the same flights. Result counts are also lower than what the suppliers send us."
2. **Bookings:** "Some AeroLink bookings, roughly one in six, fail the price check at booking
   with PRICE_MISMATCH. Our quoted total is a few cents lower than AeroLink's. SkyMesh bookings
   never fail this way."

Find the root causes and fix them. Keep the public API in `src/index.ts` unchanged.

Run the tests with `npm test`. Write what you found, and why it happened, in `NOTES.md`.
