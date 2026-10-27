import { Feedback } from "@web/components/ui/feedback";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("Feedback variants", () => {
  it("omits the optional inline title without leaving an empty paragraph", () => {
    const markup = renderToStaticMarkup(
      createElement(Feedback, { children: "안내 메시지" }),
    );
    expect(markup.match(/<p /g)).toHaveLength(1);
    expect(markup).toContain("안내 메시지");
  });

  it("renders all four tones as inline alerts or dismissible toasts", () => {
    for (const tone of ["info", "success", "warning", "error"] as const) {
      for (const kind of ["inline", "toast"] as const) {
        const properties =
          kind === "toast"
            ? {
                kind,
                tone,
                title: "알림",
                children: "안내 메시지",
                onDismiss: () => undefined,
              }
            : { kind, tone, title: "알림", children: "안내 메시지" };
        const markup = renderToStaticMarkup(
          createElement(Feedback, properties),
        );
        expect(markup).toContain(`data-kind="${kind}"`);
        expect(markup).toContain(`data-tone="${tone}"`);
        expect(markup).toContain(`/icons/${tone}.svg`);
        expect(markup).toContain("안내 메시지");
        if (kind === "toast") {
          expect(markup).toContain('aria-label="알림 닫기"');
          expect(markup).toContain('type="button"');
          expect(markup).toContain(
            'role="' + (tone === "error" ? "alert" : "status") + '"',
          );
        } else {
          expect(markup).not.toContain("알림 닫기");
        }
      }
    }
  });
});
