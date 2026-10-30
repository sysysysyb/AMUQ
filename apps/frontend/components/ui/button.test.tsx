import { Button, ButtonLink } from "@frontend/components/ui/button";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("Button semantics", () => {
  it("keeps actions from submitting forms unless explicitly requested", () => {
    const action = renderToStaticMarkup(
      createElement(Button, { children: "Action", disabled: true }),
    );
    expect(action).toContain('<button type="button"');
    expect(action).toContain('disabled=""');
    const submit = renderToStaticMarkup(
      createElement(Button, { children: "Submit", type: "submit" }),
    );
    expect(submit).toContain('type="submit"');
  });

  it("keeps navigation as a real link with its destination and label", () => {
    const markup = renderToStaticMarkup(
      createElement(ButtonLink, {
        children: "Login",
        href: "/login",
        variant: "secondary",
      }),
    );
    expect(markup).toContain('href="/login"');
    expect(markup).toContain(">Login</a>");
    expect(markup).not.toContain("<button");
  });
});
