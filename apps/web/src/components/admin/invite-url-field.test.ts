// @vitest-environment jsdom
//
// Named `.ts` (not `.tsx`) to match this project's vitest `include` glob, so
// JSX is written via `createElement` instead of JSX syntax (see dialog.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { InviteUrlField } from "./invite-url-field";

afterEach(cleanup);

const URL = "https://kiri.example/invite/abc123";

describe("InviteUrlField", () => {
  it("shows the invite URL in a read-only field", () => {
    render(createElement(InviteUrlField, { url: URL }));
    const input = screen.getByLabelText("Invite link") as HTMLInputElement;
    expect(input).toHaveValue(URL);
    expect(input).toHaveAttribute("readonly");
  });

  it("copies the URL via the Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(createElement(InviteUrlField, { url: URL }));
    fireEvent.click(screen.getByRole("button", { name: /copy invite link/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("falls back to execCommand when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;

    render(createElement(InviteUrlField, { url: URL }));
    fireEvent.click(screen.getByRole("button", { name: /copy invite link/i }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });
});
