# Caravel Offers API: response notes

Our integration notes for Caravel's flight offers search (Caravel publishes an OpenAPI spec on
its developer portal; these are the parts we rely on).

- One `offers[]` entry is one bookable offer. `offerId` is unique within a response.
- `journeys[]` has one entry per requested leg, in request order.
- Segment times (`board.localTime`, `alight.localTime`) are local, **without** a UTC offset. The
  offset of each airport is in `lookups.airports[code].utcOffset`; some are not whole hours
  (`+05:30`, `+05:45`).
- `operatedBy` names the operating carrier of a codeshare; the marketing carrier is `airline`.
- `travellerPricing[]` has **one entry per traveller** (`ADULT`, `CHILD`), not one per type.
- Cabin, booking class (`rbd`) and fare basis are per traveller and per segment, in
  `segmentFares[]`, joined to the segment by `segRef`. A `segRef` is unique within its offer only,
  and `segmentFares` are not guaranteed to be in segment order.
- Branded fares send `amenities[]` per segment fare (baggage, seats, meals...). We don't use them.
- Amounts are USD decimal strings with exactly 2 decimals (`"1406.80"`).
  - `fare.total`: base + taxes for all travellers. `fare.base`: base fares only.
  - `fare.fees[]`: ticketing and payment fees, charged on top of `total`.
  - `fare.grandTotal` = `total` + fees: what the customer is charged.
- `seatsBookable`: seats available at this price for the whole offer.
