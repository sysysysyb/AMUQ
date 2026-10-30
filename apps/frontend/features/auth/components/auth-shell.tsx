import { SiteFooter } from "@frontend/components/ui/site-footer";
import type { ReactNode } from "react";

export const AuthShell = ({ children }: { children: ReactNode }) => {
  return (
    <div className="flex min-h-svh flex-col bg-bg-auth">
      <div className="flex flex-1 md:grid md:grid-cols-2">
        <aside
          className="hidden min-w-0 flex-col bg-bg-inverse p-16 text-text-inverse md:flex"
          data-testid="auth-brand-panel"
        >
          <p className="m-0 text-heading-03 font-semibold">AMUQ</p>
          <div className="flex flex-1 flex-col items-start justify-center gap-4.5">
            <p className="m-0 text-brand-display font-bold">
              <span className="block motion-safe:animate-auth-brand-enter">
                아무 자료나
              </span>
              <span className="block motion-safe:animate-auth-brand-enter motion-safe:[animation-delay:120ms]">
                Question으로.
              </span>
            </p>
            <span className="h-1 w-49.25 bg-brand-accent" aria-hidden="true" />
          </div>
        </aside>
        <main className="flex w-full min-w-0 items-center justify-center px-6 py-8 md:w-auto md:p-8">
          <section className="flex w-full flex-col gap-5 rounded-2xl bg-transparent p-0 md:w-109.5 md:max-w-full md:bg-bg-surface md:px-12 md:py-8 md:ring-1 md:ring-border-default md:ring-inset">
            {children}
          </section>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
};
