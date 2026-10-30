import { Field } from "@frontend/components/ui/field";
import { AuthField } from "@frontend/features/auth/components/auth-form";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

it("lets ordinary fields be optional while authentication fields remain required", () => {
  const properties = { label: "Email", name: "email", type: "email" };
  expect(renderToStaticMarkup(createElement(Field, properties))).not.toContain(
    'required=""',
  );
  expect(renderToStaticMarkup(createElement(AuthField, properties))).toContain(
    'required=""',
  );
});
