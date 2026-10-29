import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mergeItineraries, parseCaravel, parseTessera } from "../src/index.ts";

// The response QA captured for ticket 1: XB4417 connects in Delhi the morning after XB581 leaves Dubai.
const capture = (): string => readFileSync(new URL("../dev/captures/tessera-qa-4471.json", import.meta.url), "utf8");

test("a connection on the day after the leg date is dated from its departureDayOffset", () => {
  const [saver] = parseTessera(capture(), "tessera");
  const [xb581, xb4417] = saver.journeys[0].segments;
  assert.equal(xb581.arrivalUtc, "2026-12-01T21:30:00.000Z");
  assert.equal(xb4417.departureUtc, "2026-12-02T00:45:00.000Z");
  assert.equal(xb4417.arrivalUtc, "2026-12-02T06:25:00.000Z");
  assert.equal(saver.durationMinutes, 715 + 445);
});

test("no Tessera itinerary has a negative duration or overlapping flights", () => {
  for (const it of parseTessera(capture(), "tessera")) {
    assert.ok(it.durationMinutes > 0, it.id);
    for (const j of it.journeys) {
      for (let k = 1; k < j.segments.length; k++) assert.ok(j.segments[k].departureUtc > j.segments[k - 1].arrivalUtc, it.id);
    }
  }
});

test("an arrival day offset counts from the flight's own departure date", () => {
  const doc = JSON.parse(capture());
  const xb4417 = doc.shopResponse.scheduleTable.find((s: { id: number }) => s.id === 14);
  xb4417.arrival = { ...xb4417.arrival, time: "01:10:00+08:00", dayOffset: 1 };
  const [saver] = parseTessera(JSON.stringify(doc), "tessera");
  assert.equal(saver.journeys[0].segments[1].arrivalUtc, "2026-12-02T17:10:00.000Z");
});

test("the Tessera copy of a trip now merges with the other suppliers' copies", () => {
  const caravel = JSON.parse(readFileSync(new URL("./fixtures/caravel-dxb-sin.json", import.meta.url), "utf8"));
  // The QA search's Caravel offer 1: XB581 22:30 from Dubai, XB4417 06:15 the next morning from Delhi.
  const seg = caravel.offers[0].journeys[0].segments;
  seg[0].board.localTime = "2026-12-01T22:30:00";
  seg[0].alight.localTime = "2026-12-02T03:00:00";
  seg[1].board.localTime = "2026-12-02T06:15:00";
  seg[1].alight.localTime = "2026-12-02T14:25:00";
  const merged = mergeItineraries([parseCaravel(JSON.stringify(caravel), "caravel"), parseTessera(capture(), "tessera")], ["caravel", "tessera"]);
  const xb581k = merged.filter((it) => it.journeys[0].segments[0].flightNumber === "XB581" && it.journeys[0].segments[0].bookingCode === "K");
  assert.deepEqual(xb581k.map((it) => it.id), ["tessera:1.1"]);
});
