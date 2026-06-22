// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { MultiSelect } from "./multi_select.js";

describe("MultiSelect pill collapse", () => {
  let trigger;
  let panel;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="trigger" class="ms-trigger"></button>
      <div id="panel" hidden></div>
    `;
    trigger = document.getElementById("trigger");
    panel = document.getElementById("panel");
  });

  it("shows only maxVisiblePills and an ellipsis when many values are selected", () => {
    const ms = new MultiSelect(trigger, panel, { maxVisiblePills: 2 });
    ms.setItems(
      [
        { value: "a", label: "alpha" },
        { value: "b", label: "beta" },
        { value: "c", label: "gamma" },
        { value: "d", label: "delta" },
      ],
      ["a", "b", "c", "d"],
    );

    expect(trigger.querySelectorAll(".ms-pill:not(.ms-pill-more)")).toHaveLength(2);
    expect(trigger.textContent).toContain("alpha");
    expect(trigger.textContent).toContain("beta");
    expect(trigger.textContent).not.toContain("delta");
    expect(trigger.querySelector("[data-ms-expand]")).not.toBeNull();
  });

  it("renders public/private badges in the panel", () => {
    const ms = new MultiSelect(trigger, panel);
    ms.setItems([
      { value: "org/pub", label: "pub", badge: "public" },
      { value: "org/sec", label: "sec", badge: "private" },
    ]);

    expect(panel.querySelector(".ms-badge-public")?.textContent).toBe("public");
    expect(panel.querySelector(".ms-badge-private")?.textContent).toBe("private");
  });

  it("expands all pills when the ellipsis is clicked", () => {
    const ms = new MultiSelect(trigger, panel, { maxVisiblePills: 2 });
    ms.setItems(
      [
        { value: "a", label: "alpha" },
        { value: "b", label: "beta" },
        { value: "c", label: "gamma" },
      ],
      ["a", "b", "c"],
    );

    trigger.querySelector("[data-ms-expand]").click();
    expect(trigger.classList.contains("ms-trigger-expanded")).toBe(true);
    expect(trigger.querySelectorAll(".ms-pill:not(.ms-pill-more)")).toHaveLength(3);
    expect(trigger.textContent).toContain("gamma");
  });
});
