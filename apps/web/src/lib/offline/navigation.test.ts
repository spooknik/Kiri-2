import { describe, expect, it } from "vitest";
import { decideNavigation, isPlainLeftClick, navigationTarget } from "@/lib/offline/navigation";

describe("decideNavigation", () => {
  it("leaves online clicks to next/link", () => {
    expect(decideNavigation({ online: true, cached: false })).toBe("client");
    expect(decideNavigation({ online: true, cached: true })).toBe("client");
  });

  it("does a full navigation offline when the document is cached", () => {
    expect(decideNavigation({ online: false, cached: true })).toBe("document");
  });

  it("sends an uncached offline click to the hub", () => {
    expect(decideNavigation({ online: false, cached: false })).toBe("offline");
  });
});

describe("navigationTarget", () => {
  it("maps decisions to destinations", () => {
    expect(navigationTarget("client", "/series/abc")).toBeNull();
    expect(navigationTarget("document", "/series/abc")).toBe("/series/abc");
    expect(navigationTarget("offline", "/series/abc")).toBe("/offline");
  });
});

describe("isPlainLeftClick", () => {
  const base = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  it("accepts an unmodified primary click", () => {
    expect(isPlainLeftClick(base)).toBe(true);
  });

  it("ignores middle/right clicks and modifier gestures", () => {
    expect(isPlainLeftClick({ ...base, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...base, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, altKey: true })).toBe(false);
  });

  it("respects an onClick handler that already handled the event", () => {
    expect(isPlainLeftClick({ ...base, defaultPrevented: true })).toBe(false);
  });
});
