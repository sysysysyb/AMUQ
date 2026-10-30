import Link from "next/link";

export const SiteFooter = () => {
  return (
    <footer className="flex min-h-49 flex-col items-center justify-center gap-5 border-0 border-t border-solid border-border-footer bg-bg-subtlest px-6 py-7 md:min-h-32 md:flex-row md:justify-between md:gap-0 md:px-20 md:py-8">
      <p className="m-0 text-heading-03 font-semibold">AMUQ</p>
      <nav className="flex gap-5 text-xs/4 md:gap-6" aria-label="법적 고지">
        <Link
          className="-my-3.5 inline-flex min-h-11 min-w-11 items-center justify-center text-black no-underline hover:underline hover:underline-offset-3"
          href="/privacy"
        >
          개인정보 처리방침
        </Link>
        <Link
          className="-my-3.5 inline-flex min-h-11 min-w-11 items-center justify-center text-black no-underline hover:underline hover:underline-offset-3"
          href="/terms"
        >
          이용약관
        </Link>
      </nav>
    </footer>
  );
};
