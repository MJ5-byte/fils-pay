import { useEffect, useRef, useState } from "react";

export function useNavigationDrawer(pathname: string) {
  const [menuOpen, setMenuOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const previousOverflow = document.body.style.overflow;
    const sync = () => {
      sheetRef.current?.toggleAttribute("inert", media.matches && !menuOpen);
      mainRef.current?.toggleAttribute("inert", media.matches && menuOpen);
      document.body.style.overflow = media.matches && menuOpen ? "hidden" : previousOverflow;
      if (!media.matches) setMenuOpen(false);
    };
    sync();
    media.addEventListener("change", sync);
    const keydown = (event: KeyboardEvent) => {
      if (!menuOpen || !media.matches) return;
      if (event.key === "Escape") { setMenuOpen(false); menuRef.current?.focus(); }
      if (event.key === "Tab") {
        const links = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? []);
        const items = [menuRef.current, ...links].filter((item): item is HTMLElement => Boolean(item));
        const index = items.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("keydown", keydown);
      document.body.style.overflow = previousOverflow;
      mainRef.current?.removeAttribute("inert");
    };
  }, [menuOpen]);
  return { menuOpen, setMenuOpen, sheetRef, menuRef, mainRef };
}
