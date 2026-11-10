import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { normalizeClientName } from "@/lib/clients";

export type SearchPickerOption = { id: string; label: string; sub?: string | null; search?: string };

/**
 * Searchable combobox (type-to-filter, works with the mobile keyboard).
 * Same interaction model as the client picker: tap → type → choose.
 */
export function SearchPicker({
  id,
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  ariaLabel,
  displayValue,
  disabled = false,
}: {
  id?: string;
  options: SearchPickerOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  emptyText: string;
  ariaLabel: string;
  displayValue?: string;
  disabled?: boolean;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const selected = (options ?? []).find((option) => option.id === value);
  const term = normalizeClientName(query);
  const filtered = (options ?? []).filter((option) =>
    normalizeClientName([option.label, option.sub, option.search].filter(Boolean).join(" ")).includes(term),
  );

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId, open]);

  function startSearch() {
    if (!open && !disabled) {
      setQuery("");
      setActive(-1);
      setOpen(true);
    }
  }

  function choose(optionId: string) {
    onChange(optionId);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div
      ref={root}
      dir="rtl"
      className="relative"
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <Input
        id={id}
        type="search"
        inputMode="text"
        autoComplete="off"
        disabled={disabled}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={placeholder}
        value={open ? query : displayValue ?? selected?.label ?? ""}
        onFocus={startSearch}
        onClick={startSearch}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) startSearch();
            setActive((index) =>
              event.key === "ArrowDown" ? Math.min(index + 1, filtered.length - 1) : Math.max(index - 1, 0),
            );
          } else if (event.key === "Enter" && open && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (active >= 0 && filtered[active]) choose(filtered[active].id);
          }
        }}
        className="h-11"
      />
      {open && !disabled ? (
        <div className="absolute z-40 mt-1 w-full rounded-lg border border-input bg-card shadow-sm">
          <div id={listId} role="listbox" aria-label={ariaLabel} className="max-h-60 overflow-y-auto overscroll-contain">
            {filtered.map((option, index) => (
              <button
                key={option.id}
                id={`${listId}-${index}`}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={option.id === value}
                className={`block min-h-11 w-full break-words px-3 py-2 text-start text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none ${active === index || option.id === value ? "bg-muted" : ""}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  choose(option.id);
                }}
              >
                <span className="block font-medium text-foreground">{option.label}</span>
                {option.sub ? <span className="block text-xs text-muted-foreground">{option.sub}</span> : null}
              </button>
            ))}
          </div>
          {!filtered.length ? <p role="status" className="px-3 py-3 text-sm text-muted-foreground">{emptyText}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
