# Keystone low-fare search: response notes

Keystone's API is XML. Their JSON gateway converts it mechanically, which shows in the shapes.

- **Lists:** an element with several children becomes an array, a single child becomes a bare
  object, and no children means the field is missing. Any list can arrive in any of the three
  forms.
- Text content of an element with attributes arrives as `"#text"` (e.g. in `codeshareInfo`).
- Everything is keyed: `segmentIndex.seg[].key`, `fareInfoIndex.fareInfo[].key`,
  `routeIndex.route.leg[].key`. Keys are opaque, case-sensitive strings and can contain `/`, `+`
  and `=`.
- Segment times (`departs`, `arrives`) are ISO 8601 local times **with** the UTC offset.
- **Price points:** one `pricePoint` is one price. Under its first `pricingInfo`, each leg
  (`flightOption`, by `legRef`) lists one or more `option`s. Every combination of one option per
  leg is a bookable itinerary at that price. The options are repeated under each `pricingInfo`
  with their own keys; we name an itinerary after the price point and the first pricingInfo's
  option keys.
- `bookingInfo[]` gives the booking code, cabin and `bookingCount` (seats) of each flight of an
  option, and points at the segment and the fare.
- `pricingInfo` is per passenger type. Its amounts cover **all** passengers of that type; there is
  one `passengerType` entry per passenger. `platingCarrier` is the validating carrier.
- Amounts are strings prefixed with their currency: `"USD1406.80"`. Every amount we accept is
  exactly `USD` followed by a Caravel-style amount (digits, a point, then 2 digits). Anything
  else is not a Keystone amount: another currency (`"EUR1406.80"`), a missing or lowercase prefix
  (`"1406.80"`, `"usd1406.80"`), or other decimals (`"USD1.234"`).
