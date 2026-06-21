import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLogger } from "./logger";

describe("createLogger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes messages with [tag]", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("MyService");
    log.error("something broke");
    expect(spy).toHaveBeenCalledWith("[MyService] something broke");
  });

  it("passes extra args through", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = createLogger("App");
    log.warn("disk full", 42, { free: 0 });
    expect(spy).toHaveBeenCalledWith("[App] disk full", 42, { free: 0 });
  });

  it("supports all four levels", () => {
    const log = createLogger("Test");
    const spies = [
      vi.spyOn(console, "debug").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(spies[0]).toHaveBeenCalledWith("[Test] d");
    expect(spies[1]).toHaveBeenCalledWith("[Test] i");
    expect(spies[2]).toHaveBeenCalledWith("[Test] w");
    expect(spies[3]).toHaveBeenCalledWith("[Test] e");
  });

  it("handles empty tag", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createLogger("");
    log.info("no tag");
    expect(spy).toHaveBeenCalledWith("[] no tag");
  });

  it("handles special characters in tag", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = createLogger("GDrive/API");
    log.debug("request sent");
    expect(spy).toHaveBeenCalledWith("[GDrive/API] request sent");
  });
});
