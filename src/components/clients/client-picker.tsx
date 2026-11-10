import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { clientPickerCopy as copy } from "@/content/client-picker";
import { normalizeClientName } from "@/lib/clients";
import type { Client } from "@/lib/types";

export function ClientPicker({
  id, clients, value, onChange, emptyLabel = copy.choose, disabled = false,
}: {
  id?: string;
  clients: Client[];
  value: string;
  onChange: (id: string) => void;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const selected = (clients ?? []).find((client) => client.id === value);
  const term = normalizeClientName(query);
  const filtered = (clients ?? []).filter((client) =>
    normalizeClientName([client.name, client.contact_name, client.company, client.phone, client.email, client.tax_id].filter(Boolean).join(" ")).includes(term),
  );
  const options = [{ id: "", name: emptyLabel }, ...filtered];

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
    if (!open) {
      setQuery("");
      setActive(-1);
      setOpen(true);
    }
  }

  function choose(clientId: string) {
    onChange(clientId);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div ref={root} dir="rtl" className="relative" onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }}>
      <Input
        id={id}
        type="search"
        inputMode="text"
        autoComplete="off"
        disabled={disabled}
        role="combobox"
        aria-label={copy.label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={copy.placeholder}
        value={open ? query : selected?.name ?? (value ? "" : emptyLabel)}
        onFocus={startSearch}
        onClick={startSearch}
        onChange={(event) => { setQuery(event.target.value); setActive(-1); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) startSearch();
            setActive((index) => event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0));
          } else if (event.key === "Enter" && open && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (active >= 0 && options[active]) choose(options[active].id);
          }
        }}
      />
      {open && !disabled ? (
        <div className="absolute z-40 mt-1 w-full rounded-lg border border-input bg-card shadow-sm">
          <div id={listId} role="listbox" aria-label={copy.label} className="max-h-52 overflow-y-auto overscroll-contain">
            {options.map((option, index) => (
              <button
                key={option.id}
                id={`${listId}-${index}`}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={option.id === value}
                className={`block min-h-11 w-full break-words px-3 py-2 text-start text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none ${active === index || option.id === value ? "bg-muted" : ""}`}
                onClick={(event) => { event.preventDefault(); event.stopPropagation(); choose(option.id); }}
              >
                {option.name}
              </button>
            ))}
          </div>
          {!filtered.length ? <p role="status" className="px-3 py-3 text-sm text-muted-foreground">{copy.empty}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
