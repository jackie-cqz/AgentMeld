import { describe, expect, it } from "vitest";
import { constrainPanelWidth, getWorkspacePanelBounds } from "./workspace-panel-layout";

describe("workspace panel geometry", () => {
  it("reserves a usable conversation on desktop", () => {
    expect(getWorkspacePanelBounds(1440, 280)).toEqual({ min: 380, max: 800 });
    expect(getWorkspacePanelBounds(1024, 280)).toEqual({ min: 380, max: 384 });
    expect(constrainPanelWidth(640, getWorkspacePanelBounds(1024, 280))).toBe(384);
    expect(constrainPanelWidth(384 - 24, getWorkspacePanelBounds(1024, 280))).toBe(380);
  });

  it("uses the compact rail for small-screen overlays", () => {
    expect(getWorkspacePanelBounds(390, 280)).toEqual({ min: 334, max: 334 });
    expect(constrainPanelWidth(640, getWorkspacePanelBounds(768, 280))).toBe(640);
  });
});
