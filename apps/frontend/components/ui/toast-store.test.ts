import { createToastStore } from "@frontend/components/ui/toast-store";
import { describe, expect, it } from "vitest";

describe("toast state", () => {
  it("keeps a notification until it is explicitly dismissed", () => {
    const store = createToastStore();
    const id = store.getState().showToast({
      title: "계정 연결 완료",
      message: "계정 연결이 완료됐어요.",
      tone: "success",
    });

    expect(store.getState().toast).toEqual({
      id,
      title: "계정 연결 완료",
      message: "계정 연결이 완료됐어요.",
      tone: "success",
    });
    store.getState().dismissToast(id);
    expect(store.getState().toast).toBeUndefined();
  });

  it("does not let an old page cleanup dismiss a newer notification", () => {
    const store = createToastStore();
    const oldId = store.getState().showToast({ message: "재설정 시간 안내" });
    const newId = store.getState().showToast({ message: "계정 연결 완료" });

    store.getState().dismissToast(oldId);

    expect(newId).not.toBe(oldId);
    expect(store.getState().toast?.id).toBe(newId);
  });

  it("does not share notifications between separate app instances", () => {
    const first = createToastStore();
    const second = createToastStore();

    first.getState().showToast({ message: "첫 번째 앱의 알림" });

    expect(second.getState().toast).toBeUndefined();
  });
});
