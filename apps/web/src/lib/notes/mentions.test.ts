import { describe, expect, it } from "vitest";
import { findMentions, type MentionCandidate } from "./mentions";

const CANDIDATES: MentionCandidate[] = [
  { id: "ann", displayName: "Ann" },
  { id: "ann-marie", displayName: "Ann Marie" },
  { id: "bo", displayName: "Bo" },
  { id: "club", displayName: "Reading Club" },
];

describe("findMentions", () => {
  it("finds a plain mention", () => {
    expect(findMentions("thanks @Bo", CANDIDATES)).toEqual(["bo"]);
  });

  it("is case-insensitive", () => {
    expect(findMentions("@ANN was right", CANDIDATES)).toEqual(["ann"]);
    expect(findMentions("@reading club meets today", CANDIDATES)).toEqual(["club"]);
  });

  it("matches display names containing spaces", () => {
    expect(findMentions("ask @Reading Club about it", CANDIDATES)).toEqual(["club"]);
  });

  it("prefers the longest matching name", () => {
    expect(findMentions("@Ann Marie said so", CANDIDATES)).toEqual(["ann-marie"]);
  });

  it("still matches the short name when the long one does not fit", () => {
    expect(findMentions("@Ann said so", CANDIDATES)).toEqual(["ann"]);
  });

  it("deduplicates and keeps first-appearance order", () => {
    expect(findMentions("@Bo and @Ann and @Bo again", CANDIDATES)).toEqual(["bo", "ann"]);
  });

  it("ignores an @ inside a word or an e-mail address", () => {
    expect(findMentions("mail bo@Ann.example.com", CANDIDATES)).toEqual([]);
    expect(findMentions("foo@Bo", CANDIDATES)).toEqual([]);
  });

  it("ignores names nobody has", () => {
    expect(findMentions("@Nobody here", CANDIDATES)).toEqual([]);
  });

  it("matches at the very start and end of the body", () => {
    expect(findMentions("@Ann", CANDIDATES)).toEqual(["ann"]);
    expect(findMentions("hey\n@Bo", CANDIDATES)).toEqual(["bo"]);
  });

  it("handles an empty body or an empty candidate list", () => {
    expect(findMentions("", CANDIDATES)).toEqual([]);
    expect(findMentions("@Ann", [])).toEqual([]);
    expect(findMentions("@Ann", [{ id: "blank", displayName: "   " }])).toEqual([]);
  });

  it("does not let a bare @ crash the scan", () => {
    expect(findMentions("what @ even is this", CANDIDATES)).toEqual([]);
  });
});
