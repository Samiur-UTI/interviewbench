# Tessera Shop API: response guide (excerpt)

Excerpt from Tessera's partner documentation, section 4 "Reading a shop response". Kept here for
the integration; the full guide is on the Tessera partner portal.

## 4.1 Description tables

To keep responses small, everything that repeats is sent once, in a table, and referenced by `id`:

| Table | One row per | Referenced from |
|---|---|---|
| `scheduleTable` | flight (carrier, number, times, airports) | `legTable[].schedules[].ref` |
| `legTable` | sequence of flights flown as one leg | `itineraries[].legs[].ref` |
| `fareComponentTable` | fare component (fare basis, amount, governing carrier) | `paxQuote.fareComponents[].ref` |
| `taxTable` | tax amount | `paxQuote.taxes[].ref` |

Ids are unique within a table. They are not contiguous and tables are not sorted: always look rows
up by `id`, never by position.

## 4.2 Dates and times

Schedules are shared between dates, so a schedule carries **local times only**, with the UTC offset
of the airport: `"time": "06:15:00+05:30"`.

The date comes from the request side of the response:

- Each group's `header.slices[i].date` is the departure date of leg `i` (local date at the leg's
  origin). An alternate-date search returns one group per date combination.
- `legTable[].schedules[k].departureDayOffset` is the number of days between the leg's date and
  the departure date of that flight (local dates). It is non-zero when a connection departs on a
  later day than the leg started, for example after an overnight flight, and can be -1 when a
  westbound flight lands on an earlier local date.
- `scheduleTable[].arrival.dayOffset` is the number of days between the flight's departure date
  and its arrival date (local dates).

**Default values are omitted.** A `departureDayOffset` or `dayOffset` of 0 is not sent.

Example: a leg dated 2026-03-14 with `schedules: [{ "ref": 31 }, { "ref": 46, "departureDayOffset": 1 }]`.
Flight 31 departs on 14 March. Flight 46 departs on 15 March; if its schedule has
`"arrival": { ..., "dayOffset": 1 }` it arrives on 16 March.

## 4.3 Fares

- Each itinerary has one or more `quotes` (brands). Every quote is bookable on its own.
- `paxQuote.fareComponents[].segments[]` list the booking code, cabin code and seats of each flight
  **in flight order across the whole itinerary**. A fare component can cover several flights,
  including flights of different legs.
- Cabin codes: `Y` economy, `S` premium economy, `C`/`J` business, `F`/`P` first.
- Amounts are integer US cents. `perPaxTotal` is per passenger of that type (`paxCount`
  passengers); `totalFare` is for all passengers.
