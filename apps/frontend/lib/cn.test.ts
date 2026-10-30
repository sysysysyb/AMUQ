import { cn } from "@frontend/lib/cn";
import { expect, test } from "vitest";

test("combines conditional classes and lets callers override Tailwind utilities", () => {
  expect(
    cn(
      "field px-3 text-action-primary",
      [false, { "opacity-50": true }],
      {
        hidden: false,
      },
      "px-4 text-danger",
    ),
  ).toBe("field opacity-50 px-4 text-danger");
});
