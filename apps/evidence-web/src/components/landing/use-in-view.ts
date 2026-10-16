import { useEffect, useRef, useState } from "react";

/**
 * Tracks whether an element is on screen. With `once`, it latches true after the
 * first intersection, which suits reveal-on-scroll; without it, the value follows
 * visibility so loops can pause while off screen.
 */
export function useInView<T extends Element>(
  options: { once?: boolean; rootMargin?: string } = {}
): [React.RefObject<T | null>, boolean] {
  const { once = false, rootMargin = "0px" } = options;
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          setInView(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { rootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [once, rootMargin]);

  return [ref, inView];
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}
