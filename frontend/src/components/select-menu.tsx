"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A dropdown whose option list is our own markup instead of the browser's
 * native <select> popup, which browsers and operating systems draw themselves
 * and don't reliably style (fonts in particular).
 *
 * Follows the ARIA "select-only combobox" pattern: focus stays on the button
 * and the highlighted option is announced through aria-activedescendant.
 * Keys: Arrows / Home / End move, Enter or Space picks, Escape closes, and
 * typing a letter jumps to the next option starting with it.
 */
export function SelectMenu<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0); // highlighted option while open
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  // Close when clicking anywhere outside the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openMenu = () => {
    setActive(selectedIndex);
    setOpen(true);
  };

  const choose = (index: number) => {
    onChange(options[index].value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        if (!open) return openMenu();
        setActive((i) => Math.min(last, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1))));
        return;
      }
      case "Home":
      case "End":
        if (open) {
          e.preventDefault();
          setActive(e.key === "Home" ? 0 : last);
        }
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (open) choose(active);
        else openMenu();
        return;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        return;
      case "Tab":
        setOpen(false);
        return;
    }

    // Typeahead: next option whose label starts with the typed letter.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const from = open ? active : selectedIndex;
      const letter = e.key.toLowerCase();
      const next = options
        .map((_, k) => (from + 1 + k) % options.length)
        .find((i) => options[i].label.toLowerCase().startsWith(letter));
      if (next === undefined) return;
      if (open) setActive(next);
      else onChange(options[next].value);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className="flex h-10 min-w-48 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white pr-3 pl-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:border-red-500 focus:outline-none"
      >
        <span className="truncate">{options[selectedIndex]?.label}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute top-11 left-0 z-30 w-full min-w-52 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()} // keep focus on the button
              onClick={() => choose(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-semibold ${
                i === active ? "bg-slate-100 text-slate-900" : "text-slate-700"
              }`}
            >
              <span>{o.label}</span>
              {o.value === value && <Check className="h-4 w-4 shrink-0 text-red-500" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
